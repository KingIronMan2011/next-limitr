import { Pool, PoolClient, Client } from "pg";
import type { PoolConfig } from "pg";
import { StorageAdapter, RateLimitUsage, PostgresConfig } from "../types";

export class PostgresStorage implements StorageAdapter {
  private pool: Pool | Client;
  private readonly ownsClient: boolean;
  private readonly keyPrefix = "next-limitr:";
  private readonly table = "rate_limits";

  constructor(config: PostgresConfig | Pool | Client) {
    if (this.isPgClient(config)) {
      this.pool = config;
      this.ownsClient = false;
    } else {
      const cfg = config as PostgresConfig;
      const conn = cfg.connectionString
        ? ({
            connectionString: cfg.connectionString,
            max: cfg.max,
          } as PoolConfig)
        : ({
            host: cfg.host ?? "127.0.0.1",
            port: cfg.port ?? 5432,
            user: cfg.user,
            password: cfg.password,
            database: cfg.database,
            max: cfg.max,
          } as PoolConfig);

      this.pool = new Pool(conn);
      this.ownsClient = true;

      // warm up pool (safe because we created a Pool)
      (this.pool as Pool)
        .connect()
        .then((c) => c.release())
        .catch(() => {});
      // ensure table exists asynchronously
      this.ensureTable().catch(() => {});
    }
  }

  private isPgClient(obj: unknown): obj is Pool | Client {
    if (!obj || typeof obj !== "object") return false;
    return typeof (obj as Record<string, unknown>)["connect"] === "function";
  }

  private isPoolClient(obj: PoolClient | Client): obj is PoolClient {
    return typeof (obj as PoolClient).release === "function";
  }

  private isPool(obj: Pool | Client): obj is Pool {
    return (
      typeof (obj as Pool).connect === "function" &&
      typeof (obj as Pool).end === "function"
    );
  }

  private getKey(key: string): string {
    return `${this.keyPrefix}${key}`;
  }

  private async getRawClient(): Promise<PoolClient | Client> {
    if (this.isPool(this.pool)) {
      return this.pool.connect();
    }
    return this.pool as Client;
  }

  private async ensureTable(): Promise<void> {
    const client = await this.getRawClient();
    const release = this.isPoolClient(client)
      ? client.release.bind(client)
      : undefined;
    try {
      await client.query(
        `CREATE TABLE IF NOT EXISTS ${this.table} (
          id TEXT PRIMARY KEY,
          count BIGINT NOT NULL,
          expire_at TIMESTAMPTZ
        );`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS ${this.table}_id_idx ON ${this.table} (id);`,
      );
    } finally {
      if (release) release();
    }
  }

  async increment(key: string, windowMs: number): Promise<RateLimitUsage> {
    await this.ensureTable();
    const id = this.getKey(key);
    const expireAt = new Date(Date.now() + windowMs).toISOString();
    const client = await this.getRawClient();
    const release = this.isPoolClient(client)
      ? client.release.bind(client)
      : undefined;
    try {
      const q = `
INSERT INTO ${this.table} (id, count, expire_at)
VALUES ($1, 1, $2::timestamptz)
ON CONFLICT (id) DO UPDATE
  SET count = CASE WHEN ${this.table}.expire_at < now() THEN 1 ELSE ${this.table}.count + 1 END,
      expire_at = CASE WHEN ${this.table}.expire_at < now() THEN EXCLUDED.expire_at ELSE ${this.table}.expire_at END
RETURNING count, extract(epoch from expire_at) * 1000 AS expire_at_ms;
`;
      const res = await client.query(q, [id, expireAt]);
      if (!res.rows || res.rows.length === 0) {
        throw new Error("Postgres increment failed");
      }
      const row = res.rows[0] as {
        count: string | number;
        expire_at_ms?: string | number;
      };
      const count = Number(row.count ?? 0);
      const expireAtMs = Number(row.expire_at_ms ?? Date.now() + windowMs);
      const ttl = Math.max(expireAtMs - Date.now(), 0);
      const reset = Math.floor((Date.now() + ttl) / 1000);
      const limit = Number.MAX_SAFE_INTEGER;
      const remaining = Math.max(limit - count, 0);
      return { limit, remaining, reset, used: count };
    } finally {
      if (release) release();
    }
  }

  async decrement(key: string): Promise<void> {
    await this.ensureTable();
    const id = this.getKey(key);
    const client = await this.getRawClient();
    const release = this.isPoolClient(client)
      ? client.release.bind(client)
      : undefined;
    try {
      await client.query(
        `UPDATE ${this.table} SET count = count - 1 WHERE id = $1 AND count > 0;`,
        [id],
      );
    } finally {
      if (release) release();
    }
  }

  async reset(key: string): Promise<void> {
    await this.ensureTable();
    const id = this.getKey(key);
    const client = await this.getRawClient();
    const release = this.isPoolClient(client)
      ? client.release.bind(client)
      : undefined;
    try {
      await client.query(`DELETE FROM ${this.table} WHERE id = $1;`, [id]);
    } finally {
      if (release) release();
    }
  }

  async close(): Promise<void> {
    if (this.ownsClient) {
      if (this.isPool(this.pool)) {
        await (this.pool as Pool).end();
      } else if (typeof (this.pool as Client).end === "function") {
        await (this.pool as Client).end();
      }
    }
  }

  async getActiveKeys(): Promise<string[]> {
    await this.ensureTable();
    const prefix = this.keyPrefix;
    const client = await this.getRawClient();
    const release = this.isPoolClient(client)
      ? client.release.bind(client)
      : undefined;
    try {
      const q = `SELECT id FROM ${this.table} WHERE id LIKE $1;`;
      const res = await client.query(q, [`${prefix}%`]);
      const rows = res.rows as Array<{ id: string }>;
      return rows.map((r) => String(r.id).slice(prefix.length));
    } finally {
      if (release) release();
    }
  }
}

import { sql, eq, and, lt } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import type { Pool, Client } from "pg";
import { Pool as PgPool } from "pg";
import type { StorageAdapter, RateLimitUsage, DrizzlePostgresConfig } from "../types";
import { rateLimits } from "./drizzle-schema";

export class DrizzlePostgresStorage implements StorageAdapter {
  private db: NodePgDatabase;
  private pool?: Pool | Client;
  private readonly ownsClient: boolean;
  private readonly keyPrefix = "next-limitr:";
  private readonly autoCreateTable: boolean;
  private tableEnsured = false;

  constructor(
    config: DrizzlePostgresConfig | NodePgDatabase,
  ) {
    // Check if user passed an existing Drizzle database instance
    if (this.isDrizzleDb(config)) {
      this.db = config;
      this.ownsClient = false;
      this.autoCreateTable = false; // User manages their own schema
    } else {
      // User provided connection config, create new instances
      const cfg = config as DrizzlePostgresConfig;
      
      // Check if user provided their own db instance in config
      if (cfg.db) {
        this.db = cfg.db;
        this.ownsClient = false;
        this.autoCreateTable = cfg.autoCreateTable ?? false;
      } else if (cfg.pool || cfg.client) {
        // User provided pg Pool/Client, wrap it with Drizzle
        this.pool = cfg.pool || cfg.client;
        this.db = drizzle(this.pool as Pool);
        this.ownsClient = false;
        this.autoCreateTable = cfg.autoCreateTable ?? true;
      } else {
        // Create new Pool from connection config
        const poolConfig = cfg.connectionString
          ? { connectionString: cfg.connectionString, max: cfg.max }
          : {
              host: cfg.host ?? "127.0.0.1",
              port: cfg.port ?? 5432,
              user: cfg.user,
              password: cfg.password,
              database: cfg.database,
              max: cfg.max,
            };
        
        this.pool = new PgPool(poolConfig);
        this.db = drizzle(this.pool);
        this.ownsClient = true;
        this.autoCreateTable = cfg.autoCreateTable ?? true;
      }
    }
  }

  private isDrizzleDb(obj: unknown): obj is NodePgDatabase {
    if (!obj || typeof obj !== "object") return false;
    // Check for Drizzle db signature (has query/execute methods)
    const db = obj as Record<string, unknown>;
    return (
      typeof db.select === "function" &&
      typeof db.insert === "function" &&
      typeof db.update === "function" &&
      typeof db.delete === "function"
    );
  }

  private getKey(key: string): string {
    return `${this.keyPrefix}${key}`;
  }

  private async ensureTable(): Promise<void> {
    if (!this.autoCreateTable || this.tableEnsured) return;
    
    try {
      await this.db.execute(sql`
        CREATE TABLE IF NOT EXISTS rate_limits (
          id TEXT PRIMARY KEY,
          count BIGINT NOT NULL,
          expire_at TIMESTAMPTZ
        )
      `);
      await this.db.execute(sql`
        CREATE INDEX IF NOT EXISTS rate_limits_id_idx ON rate_limits (id)
      `);
      this.tableEnsured = true;
    } catch (error) {
      // Table might already exist, that's fine
      this.tableEnsured = true;
    }
  }

  async increment(key: string, windowMs: number): Promise<RateLimitUsage> {
    await this.ensureTable();
    const id = this.getKey(key);
    const expireAt = new Date(Date.now() + windowMs);

    // Use raw SQL for UPSERT with conditional logic (Drizzle doesn't support complex ON CONFLICT)
    const result = await this.db.execute(sql`
      INSERT INTO rate_limits (id, count, expire_at)
      VALUES (${id}, 1, ${expireAt})
      ON CONFLICT (id) DO UPDATE
        SET count = CASE 
          WHEN rate_limits.expire_at < now() THEN 1 
          ELSE rate_limits.count + 1 
        END,
        expire_at = CASE 
          WHEN rate_limits.expire_at < now() THEN EXCLUDED.expire_at 
          ELSE rate_limits.expire_at 
        END
      RETURNING count, extract(epoch from expire_at) * 1000 AS expire_at_ms
    `);

    if (!result.rows || result.rows.length === 0) {
      throw new Error("Drizzle Postgres increment failed");
    }

    const row = result.rows[0] as {
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
  }

  async decrement(key: string): Promise<void> {
    await this.ensureTable();
    const id = this.getKey(key);

    await this.db.execute(sql`
      UPDATE rate_limits 
      SET count = count - 1 
      WHERE id = ${id} AND count > 0
    `);
  }

  async reset(key: string): Promise<void> {
    await this.ensureTable();
    const id = this.getKey(key);

    await this.db
      .delete(rateLimits)
      .where(eq(rateLimits.id, id));
  }

  async close(): Promise<void> {
    if (this.ownsClient && this.pool) {
      if (typeof (this.pool as Pool).end === "function") {
        await (this.pool as Pool).end();
      } else if (typeof (this.pool as Client).end === "function") {
        await (this.pool as Client).end();
      }
    }
  }

  async getActiveKeys(): Promise<string[]> {
    await this.ensureTable();
    const prefix = this.keyPrefix;

    const results = await this.db
      .select({ id: rateLimits.id })
      .from(rateLimits)
      .where(sql`${rateLimits.id} LIKE ${prefix + "%"}`);

    return results.map((r) => String(r.id).slice(prefix.length));
  }
}

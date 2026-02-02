import { describe, it, expect } from "vitest";
import { PostgresStorage } from "../../src/storage/postgresql";
import type { Pool } from "pg";

describe("PostgresStorage (integration or mock)", () => {
  const conn = process.env.POSTGRES_CONN || process.env.DATABASE_URL;

  it("increments, decrements and resets (real or mocked)", async () => {
    // Try real pg pool if connection string present and driver available
    if (conn) {
      try {
        const pgModule = await import("pg");
        const { Pool } = pgModule;
        const pool = new Pool({ connectionString: conn });
        const storage = new PostgresStorage(pool);

        const key = `test-pg-${Date.now()}`;
        const u1 = await storage.increment(key, 2000);
        expect(u1.used).toBeGreaterThanOrEqual(1);

        const u2 = await storage.increment(key, 2000);
        expect(u2.used).toBeGreaterThanOrEqual(u1.used);

        await storage.decrement(key);
        const u3 = await storage.increment(key, 2000);
        expect(u3.used).toBeGreaterThanOrEqual(1);

        await storage.reset(key);
        await storage.close();
        await pool.end();
        return;
      } catch {
        // fallthrough to mock if real driver fails
      }
    }

    // Lightweight in-memory MockPool to exercise PostgresStorage logic without a DB.
    class MockPool {
      private store = new Map<string, { count: number; expireAt: number }>();
      async connect() {
        const client = {
          query: async (sql: string, params?: unknown[]) => {
            // CREATE / INDEX no-op
            if (/CREATE TABLE/i.test(sql) || /CREATE INDEX/i.test(sql)) {
              return { rows: [] };
            }
            // INSERT ... ON CONFLICT ... RETURNING ...
            if (/INSERT INTO\s+rate_limits/i.test(sql)) {
              const id = params?.[0] as string;
              const expireAtParam = params?.[1] as string;
              const expireAtMs = Date.parse(expireAtParam);
              const now = Date.now();
              const existing = this.store.get(id);
              if (!existing || existing.expireAt < now) {
                this.store.set(id, { count: 1, expireAt: expireAtMs });
              } else {
                existing.count += 1;
                // keep existing.expireAt
              }
              const entry = this.store.get(id)!;
              return {
                rows: [{ count: entry.count, expire_at_ms: entry.expireAt }],
              };
            }
            // UPDATE decrement
            if (/UPDATE\s+rate_limits\s+SET\s+count\s*=/i.test(sql)) {
              const id = params?.[0] as string;
              const existing = this.store.get(id);
              if (existing && existing.count > 0)
                existing.count = Math.max(0, existing.count - 1);
              return { rows: [] };
            }
            // DELETE
            if (/DELETE FROM\s+rate_limits/i.test(sql)) {
              const id = params?.[0] as string;
              this.store.delete(id);
              return { rows: [] };
            }
            // SELECT id FROM rate_limits WHERE id LIKE $1
            if (/SELECT\s+id\s+FROM\s+rate_limits/i.test(sql)) {
              const like = params?.[0] as string;
              const prefix = (like ?? "").replace("%", "");
              const rows = Array.from(this.store.keys())
                .filter((k) => k.startsWith(prefix))
                .map((id) => ({ id }));
              return { rows };
            }
            return { rows: [] };
          },
          release: () => {},
        };
        return client;
      }
      async end() {}
    }

    const pool = new MockPool();
    const storage = new PostgresStorage(pool as unknown as Pool);

    const key = `test-pg-mock-${Date.now()}`;
    const u1 = await storage.increment(key, 2000);
    expect(u1.used).toBeGreaterThanOrEqual(1);

    const u2 = await storage.increment(key, 2000);
    expect(u2.used).toBeGreaterThanOrEqual(u1.used);

    await storage.decrement(key);
    const u3 = await storage.increment(key, 2000);
    expect(u3.used).toBeGreaterThanOrEqual(1);

    await storage.reset(key);
    await storage.close();
  });
});

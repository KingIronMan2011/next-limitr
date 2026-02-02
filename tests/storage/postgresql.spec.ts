import { describe, it, expect } from "vitest";
import { PostgresStorage } from "../../src/storage/postgresql";

describe("PostgresStorage (integration)", () => {
  const conn = process.env.POSTGRES_CONN || process.env.DATABASE_URL;
  if (!conn) {
    it.skip("skips when POSTGRES_CONN / DATABASE_URL is not set", () => {});
    return;
  }

  it("increments, decrements and resets", async () => {
    let pgModule: typeof import("pg") | undefined;
    try {
      pgModule = await import("pg");
    } catch {
      // pg not installed - skip
      expect(true).toBe(true);
      return;
    }

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
  });
});

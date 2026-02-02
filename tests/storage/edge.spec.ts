import { describe, it, expect } from "vitest";
import { EdgeStorage } from "../../src/storage/edge";
import type { KVNamespaceLike } from "../../src/types";

function makeMockKV(): KVNamespaceLike {
  const store = new Map<string, { value: string; expireAt?: number }>();
  return {
    async get(key: string) {
      const v = store.get(key);
      if (!v) return null;
      if (v.expireAt && Date.now() > v.expireAt) {
        store.delete(key);
        return null;
      }
      return v.value;
    },
    async put(
      key: string,
      value: string,
      opts?: { expiration?: number | Date; expirationTtl?: number },
    ) {
      let expireAt: number | undefined;
      if (opts?.expirationTtl)
        expireAt = Date.now() + opts.expirationTtl * 1000;
      if (opts?.expiration instanceof Date)
        expireAt = opts.expiration.getTime();
      store.set(key, { value, expireAt });
    },
    async delete(key: string) {
      store.delete(key);
    },
    async list(opts?: { prefix?: string; limit?: number }) {
      const prefix = opts?.prefix ?? "";
      const keys = Array.from(store.keys())
        .filter((k) => k.startsWith(prefix))
        .map((k) => ({ name: k }));
      return { keys };
    },
  };
}

describe("EdgeStorage (cloudflare KV mock)", () => {
  it("increments, uses KV and resets", async () => {
    const kv = makeMockKV();
    const storage = new EdgeStorage({ kind: "cloudflare", cf: { kv } });
    const key = `test-edge-${Date.now()}`;
    const u1 = await storage.increment(key, 2000);
    expect(u1.used).toBeGreaterThanOrEqual(1);

    const u2 = await storage.increment(key, 2000);
    expect(u2.used).toBeGreaterThanOrEqual(u1.used);

    await storage.decrement(key);
    const u3 = await storage.increment(key, 2000);
    expect(u3.used).toBeGreaterThanOrEqual(1);

    await storage.reset(key);
  });
});

import { describe, it, expect } from "vitest";
import { RedisStorage } from "../../src/storage/redis";
import type { RedisClientType } from "redis";

function makeMockRedisClient(): Partial<RedisClientType> {
  const store = new Map<string, string>();
  const expiry = new Map<string, number>();

  return {
    isOpen: true,
    async connect() {},
    async quit() {},

    // simulate EVAL (lua) used by RedisStorage
    async eval(
      script: string,
      opts: { keys?: string[]; arguments?: string[] },
    ) {
      const k = opts.keys?.[0] ?? "";
      const arg = opts.arguments?.[0];
      // INCR
      const v = Number(store.get(k) ?? "0") + 1;
      store.set(k, String(v));
      // ensure TTL if provided
      if (arg) {
        const ms = Number(arg);
        if (!Number.isNaN(ms)) {
          expiry.set(k, Date.now() + ms);
        }
      }
      const ttl = expiry.has(k) ? Math.max(0, expiry.get(k)! - Date.now()) : -1;
      return [v, ttl];
    },

    multi() {
      const keyOps: Array<() => unknown> = [];
      return {
        incr(k: string) {
          keyOps.push(() => {
            const v = Number(store.get(k) ?? "0") + 1;
            store.set(k, String(v));
            return v;
          });
          return this;
        },
        pExpire(k: string, ms?: number) {
          keyOps.push(() => {
            if (ms) expiry.set(k, Date.now() + ms);
            return "OK";
          });
          return this;
        },
        async exec() {
          return keyOps.map((fn) => fn());
        },
      };
    },
    async pTTL(k?: string) {
      if (!k) return -1;
      if (!expiry.has(k)) return -1;
      return Math.max(0, expiry.get(k)! - Date.now());
    },
    async exists(k: string) {
      return store.has(k) ? 1 : 0;
    },
    async get(k: string) {
      const exp = expiry.get(k);
      if (exp && Date.now() > exp) {
        store.delete(k);
        expiry.delete(k);
        return null;
      }
      return store.get(k) ?? null;
    },
    async decr(k: string) {
      const v = Number(store.get(k) ?? "0") - 1;
      store.set(k, String(Math.max(0, v)));
    },
    async del(k: string) {
      store.delete(k);
      expiry.delete(k);
    },
    async keys(pattern: string) {
      return Array.from(store.keys()).filter((k) =>
        k.startsWith(pattern.replace("*", "")),
      );
    },
  } as unknown as Partial<RedisClientType>;
}

describe("RedisStorage (mock)", () => {
  it("increment returns usage", async () => {
    const mock = makeMockRedisClient() as unknown as RedisClientType;
    const storage = new RedisStorage(mock);
    const usage = await storage.increment("test-key", 1000);
    expect(usage.used).toBe(1);
  });
});

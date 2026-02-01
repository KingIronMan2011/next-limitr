import { describe, it, expect } from "vitest";
import { RedisStorage } from "../../src/storage/redis";
import type { RedisClientType } from "redis";

function makeMockRedisClient(): Partial<RedisClientType> {
  const store = new Map<string, string>();
  return {
    isOpen: true,
    async connect() {},
    async quit() {},

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
        pExpire() {
          keyOps.push(() => "OK");
          return this;
        },
        async exec() {
          return keyOps.map((fn) => fn());
        },
      };
    },
    async pTTL() {
      return 1000;
    },
    async exists(k: string) {
      return store.has(k) ? 1 : 0;
    },
    async get(k: string) {
      return store.get(k) ?? null;
    },
    async decr(k: string) {
      const v = Number(store.get(k) ?? "0") - 1;
      store.set(k, String(Math.max(0, v)));
    },
    async del(k: string) {
      store.delete(k);
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

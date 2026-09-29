import { describe, expect, it, vi } from "vitest";
import type IORedis from "ioredis";
import { NextRequest, NextResponse } from "next/server";
import { withRateLimit } from "../../src/middleware";
import { IORedisStorage } from "../../src/storage/ioredis";

function makeClient() {
  const values = new Map<string, number>();
  const expiries = new Map<string, number>();
  const client = {
    eval: vi.fn(
      async (script: string, _numKeys: number, key: string, ttl?: number) => {
        if (script.includes('redis.call("INCR"')) {
          const count = (values.get(key) ?? 0) + 1;
          values.set(key, count);
          if (!expiries.has(key)) expiries.set(key, Date.now() + ttl!);
          return [count, expiries.get(key)! - Date.now()];
        }
        const count = values.get(key);
        if (count !== undefined && count > 0) values.set(key, count - 1);
        return count ?? null;
      },
    ),
    del: vi.fn(async (key: string) => {
      values.delete(key);
      expiries.delete(key);
      return 1;
    }),
    keys: vi.fn(async () => [...values.keys()]),
    quit: vi.fn(async () => "OK"),
  };
  return client;
}

describe("IORedisStorage", () => {
  it("increments atomically with a fixed expiry and decrements", async () => {
    const client = makeClient();
    const storage = new IORedisStorage(client as unknown as IORedis);

    expect((await storage.increment("user", 60_000)).used).toBe(1);
    expect((await storage.increment("user", 60_000)).used).toBe(2);
    expect(client.eval).toHaveBeenCalledWith(
      expect.any(String),
      1,
      "next-limitr:user",
      60_000,
    );
    await storage.decrement("user");
    expect((await storage.increment("user", 60_000)).used).toBe(2);
    expect(await storage.getActiveKeys()).toEqual(["user"]);
  });

  it("resets a prefixed key and keeps a supplied client open", async () => {
    const client = makeClient();
    const storage = new IORedisStorage(client as unknown as IORedis);

    await storage.increment("user", 1_000);
    await storage.reset("user");
    expect(client.del).toHaveBeenCalledWith("next-limitr:user");
    expect((await storage.increment("user", 1_000)).used).toBe(1);
    await storage.close();
    expect(client.quit).not.toHaveBeenCalled();
  });

  it("rejects malformed Lua replies", async () => {
    const client = makeClient();
    client.eval.mockResolvedValueOnce(["invalid", 1_000]);
    const storage = new IORedisStorage(client as unknown as IORedis);

    await expect(storage.increment("user", 1_000)).rejects.toThrow(
      "Invalid numeric reply from ioredis",
    );
  });

  it("selects ioredis in middleware and applies the request limit", async () => {
    const client = makeClient();
    const handler = withRateLimit({
      storage: "ioredis",
      ioredisClient: client as unknown as IORedis,
      limit: 1,
      windowMs: 60_000,
    })(async () => NextResponse.json({ ok: true }));
    const request = new NextRequest("http://localhost/api/test");

    expect((await handler(request)).status).toBe(200);
    expect((await handler(request)).status).toBe(429);
  });
});

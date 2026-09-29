import { afterEach, describe, it, expect, vi } from "vitest";
import { EdgeStorage } from "../../src/storage/edge";
import type { KVNamespaceLike } from "../../src/types";

function makeMockKV(): KVNamespaceLike {
  const store = new Map<
    string,
    { value: string; expireAt?: number; metadata?: { resetAt: number } }
  >();
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
      opts?: {
        expiration?: number | Date;
        expirationTtl?: number;
        metadata?: { resetAt: number };
      },
    ) {
      let expireAt: number | undefined;
      if (opts?.expirationTtl)
        expireAt = Date.now() + opts.expirationTtl * 1000;
      if (opts?.expiration instanceof Date)
        expireAt = opts.expiration.getTime();
      store.set(key, { value, expireAt, metadata: opts?.metadata });
    },
    async delete(key: string) {
      store.delete(key);
    },
    async list(opts?: { prefix?: string; limit?: number }) {
      const prefix = opts?.prefix ?? "";
      const keys = Array.from(store.keys())
        .filter((k) => k.startsWith(prefix))
        .map((k) => ({ name: k, metadata: store.get(k)?.metadata }));
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

  it("keeps a fixed window and uses Cloudflare's minimum supported TTL", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const kv = makeMockKV();
    const put = vi.spyOn(kv, "put");
    const storage = new EdgeStorage({ kind: "cloudflare", cf: { kv } });

    const first = await storage.increment("user", 2_000);
    vi.advanceTimersByTime(500);
    const second = await storage.increment("user", 2_000);
    expect(second.used).toBe(2);
    expect(second.reset).toBe(first.reset);
    await storage.decrement("user");
    expect((await storage.increment("user", 2_000)).used).toBe(2);
    for (const call of put.mock.calls) {
      expect(call[2]?.expirationTtl).toBeGreaterThanOrEqual(60);
    }

    vi.advanceTimersByTime(2_000);
    expect(await storage.getActiveKeys()).toEqual([]);
    expect((await storage.increment("user", 2_000)).used).toBe(1);
  });

  it("reads every page of Cloudflare KV keys", async () => {
    const kv = makeMockKV();
    kv.list = vi
      .fn()
      .mockResolvedValueOnce({
        keys: [{ name: "next-limitr:first" }],
        list_complete: false,
        cursor: "page-2",
      })
      .mockResolvedValueOnce({
        keys: [{ name: "next-limitr:second" }],
        list_complete: true,
      });
    const storage = new EdgeStorage({ kind: "cloudflare", cf: { kv } });

    expect(await storage.getActiveKeys()).toEqual(["first", "second"]);
    expect(kv.list).toHaveBeenLastCalledWith({
      prefix: "next-limitr:",
      cursor: "page-2",
    });
  });
});

describe("EdgeStorage (Upstash REST)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("posts EVAL to the REST base URL", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(Response.json({ result: [1, 2_000] }));
    vi.stubGlobal("fetch", fetchMock);
    const storage = new EdgeStorage({
      kind: "upstash",
      upstash: { url: "https://redis.example.test/", token: "secret" },
    });

    expect((await storage.increment("user", 2_000)).used).toBe(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://redis.example.test",
      expect.objectContaining({
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer secret",
        },
        body: expect.stringContaining('"EVAL"'),
      }),
    );
  });

  it("surfaces REST errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          Response.json({ error: "invalid token" }, { status: 401 }),
        ),
    );
    const storage = new EdgeStorage({
      kind: "upstash",
      upstash: { url: "https://redis.example.test", token: "bad" },
    });

    await expect(storage.increment("user", 2_000)).rejects.toThrow(
      "Upstash command failed: invalid token",
    );
  });

  it("scans all Upstash keys", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({ result: ["7", ["next-limitr:first"]] }),
      )
      .mockResolvedValueOnce(
        Response.json({ result: ["0", ["next-limitr:second"]] }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const storage = new EdgeStorage({
      kind: "upstash",
      upstash: { url: "https://redis.example.test" },
    });

    expect(await storage.getActiveKeys()).toEqual(["first", "second"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

afterEach(() => vi.useRealTimers());

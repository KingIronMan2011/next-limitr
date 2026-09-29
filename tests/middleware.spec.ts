import { NextRequest, NextResponse } from "next/server";
import type IORedis from "ioredis";
import { describe, expect, it, vi } from "vitest";
import { withRateLimit } from "../src/middleware";

describe("withRateLimit", () => {
  it("keeps memory usage across requests", async () => {
    const handler = withRateLimit({ limit: 1, windowMs: 60_000 })(async () =>
      NextResponse.json({ ok: true }),
    );
    const request = new NextRequest("http://localhost/api/test");

    expect((await handler(request)).status).toBe(200);
    expect((await handler(request)).status).toBe(429);
  });

  it("prefers a prefix route over the global wildcard", async () => {
    const handler = withRateLimit({
      limit: 1,
      routes: {
        "*": { limit: 1 },
        "/api/*": { limit: 1 },
        "/api/relaxed/*": { limit: 2 },
      },
    })(async () => NextResponse.json({ ok: true }));
    const request = new NextRequest("http://localhost/api/relaxed/test");

    expect((await handler(request)).status).toBe(200);
    expect((await handler(request)).status).toBe(200);
    expect((await handler(request)).status).toBe(429);
  });

  it("does not call a failing handler twice", async () => {
    const failingHandler = vi.fn(async () => {
      throw new Error("handler failed");
    });
    const handler = withRateLimit()(failingHandler);
    const request = new NextRequest("http://localhost/api/test");

    await expect(handler(request)).rejects.toThrow("handler failed");
    expect(failingHandler).toHaveBeenCalledTimes(1);
  });

  it("allows a request through when storage fails", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const client = {
      eval: vi.fn(),
      defineCommand: vi.fn(),
      nextLimitrIncrementV1: vi
        .fn()
        .mockRejectedValue(new Error("connection failed")),
    } as unknown as IORedis;
    const underlyingHandler = vi.fn(async () =>
      NextResponse.json({ ok: true }),
    );
    const handler = withRateLimit({
      storage: "ioredis",
      ioredisClient: client,
    })(underlyingHandler);

    try {
      const response = await handler(
        new NextRequest("http://localhost/api/test"),
      );
      expect(response.status).toBe(200);
      expect(underlyingHandler).toHaveBeenCalledTimes(1);
    } finally {
      error.mockRestore();
    }
  });
});

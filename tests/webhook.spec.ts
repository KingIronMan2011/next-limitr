import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { WebhookHandler } from "../src/webhook";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("WebhookHandler", () => {
  const request = new NextRequest("https://example.test/api/users");
  const usage = { used: 2, remaining: 0, reset: 1_700_000_000, limit: 1 };

  it("sends a JSON notification with a timeout", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await new WebhookHandler({ url: "https://hooks.example.test" }).notify(
      request,
      usage,
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "https://hooks.example.test",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: expect.stringContaining('"path":"/api/users"'),
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("does not interrupt the request when delivery fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      new WebhookHandler({ url: "https://hooks.example.test" }).notify(
        request,
        usage,
      ),
    ).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledOnce();
  });

  it("passes FormData without a JSON content type", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    const form = new FormData();
    form.set("event", "limited");

    await new WebhookHandler({
      url: "https://hooks.example.test",
      payload: () => form,
    }).notify(request, usage);

    expect(fetchMock).toHaveBeenCalledWith(
      "https://hooks.example.test",
      expect.objectContaining({ body: form, headers: {} }),
    );
  });
});

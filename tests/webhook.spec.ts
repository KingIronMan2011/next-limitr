import { describe, it, expect, vi, type Mock } from "vitest";
import { NextRequest } from "next/server";
import axios from "axios";
import { WebhookHandler } from "../src/webhook";
import type { WebhookConfig } from "../src/types";

vi.mock("axios");

describe("WebhookHandler", () => {
  it("notify should call axios and not throw", async () => {
    (axios.request as unknown as Mock).mockResolvedValue({
      status: 200,
      data: {},
    });
    const cfg: WebhookConfig = { url: "https://example.test" };
    const h = new WebhookHandler(cfg);
    await expect(
      h.notify(
        {
          headers: new Headers(),
          nextUrl: new URL("https://example.test/"),
        } as NextRequest,
        {
          used: 1,
          remaining: 0,
          reset: Math.floor(Date.now() / 1000) + 60,
          limit: 10,
        },
      ),
    ).resolves.not.toThrow();
  });
});

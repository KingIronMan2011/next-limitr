import type { NextRequest } from "next/server";
import type { WebhookConfig, RateLimitUsage } from "./types.js";
import { getClientIp } from "./request.js";

export class WebhookHandler {
  private config: WebhookConfig;

  constructor(config: WebhookConfig) {
    this.config = config;
  }

  async notify(req: NextRequest, usage: RateLimitUsage): Promise<void> {
    try {
      const { url, method = "POST", headers = {}, payload } = this.config;
      const body = payload
        ? payload(req, usage)
        : {
            ip: getClientIp(req),
            path: req.nextUrl.pathname,
            method: req.method,
            timestamp: new Date().toISOString(),
            usage,
          };
      const isFormData = body instanceof FormData;
      const response = await fetch(url, {
        method,
        headers: {
          ...(isFormData ? {} : { "Content-Type": "application/json" }),
          ...headers,
        },
        body: isFormData
          ? body
          : typeof body === "string"
            ? body
            : JSON.stringify(body),
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) {
        console.error("Webhook notification failed:", response.status);
      }
    } catch (error: unknown) {
      console.error("Error sending webhook notification:", error);
    }
  }
}

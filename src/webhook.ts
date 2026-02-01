import { NextRequest } from "next/server";
import { WebhookConfig, RateLimitUsage } from "./types";
import fetch from "node-fetch";

function getClientIp(req: import("next/server").NextRequest): string {
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();
  return (
    req.headers.get("x-real-ip") || req.headers.get("x-client-ip") || "unknown"
  );
}

export class WebhookHandler {
  private config: WebhookConfig;

  constructor(config: WebhookConfig) {
    this.config = config;
  }

  async notify(req: NextRequest, usage: RateLimitUsage): Promise<void> {
    const { url, method = "POST", headers = {}, payload } = this.config;

    try {
      const body = payload
        ? payload(req, usage)
        : {
            ip: getClientIp(req),
            path: req.nextUrl.pathname,
            method: req.method,
            timestamp: new Date().toISOString(),
            usage,
          };

      const response = await fetch(url, {
        method,
        headers: {
          "Content-Type": "application/json",
          ...headers,
        },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        console.error("Webhook notification failed:", await response.text());
      }
    } catch (error) {
      console.error("Error sending webhook notification:", error);
      // Don't throw the error to prevent affecting the main request flow
    }
  }
}

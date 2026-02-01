import { NextRequest } from "next/server";
import { WebhookConfig, RateLimitUsage } from "./types";
import axios, { type AxiosRequestConfig, type AxiosResponse } from "axios";

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

    const body = payload
      ? payload(req, usage)
      : {
          ip: getClientIp(req),
          path: req.nextUrl.pathname,
          method: req.method,
          timestamp: new Date().toISOString(),
          usage,
        };

    const isFormData =
      typeof FormData !== "undefined" && (body as unknown) instanceof FormData;

    const reqConfig: AxiosRequestConfig = {
      url,
      method: method as AxiosRequestConfig["method"],
      headers: {
        ...(isFormData ? {} : { "Content-Type": "application/json" }),
        ...headers,
      },
      data: body as unknown,
      timeout: 5000,
      validateStatus: () => true,
    };

    try {
      const response: AxiosResponse = await axios.request(reqConfig);
      if (response.status < 200 || response.status >= 300) {
        console.error(
          "Webhook notification failed:",
          response.status,
          response.data,
        );
      }
    } catch (error: unknown) {
      console.error("Error sending webhook notification:", error);
      // Don't throw the error to prevent affecting the main request flow
    }
  }
}

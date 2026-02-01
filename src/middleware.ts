import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import type { RateLimitOptions, StorageAdapter, NextApiHandler } from "./types";
import { RateLimitStrategy } from "./types";
import { MemoryStorage } from "./storage/memory";
import { RedisStorage } from "./storage/redis";
import { WebhookHandler } from "./webhook";

function getClientIp(req: NextRequest): string {
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();
  return (
    req.headers.get("x-real-ip") || req.headers.get("x-client-ip") || "unknown"
  );
}

const DEFAULT_OPTIONS: Partial<RateLimitOptions> = {
  limit: 100,
  windowMs: 60 * 1000, // 1 minute
  strategy: RateLimitStrategy.FIXED_WINDOW,
  storage: "memory",
};

export function withRateLimit(options: RateLimitOptions = {}) {
  const finalOptions: RateLimitOptions = {
    ...(DEFAULT_OPTIONS as RateLimitOptions),
    ...options,
  };
  let storage: StorageAdapter;
  let webhookHandler: WebhookHandler | undefined;

  // Initialize storage
  if (finalOptions.storage === "redis") {
    if (!finalOptions.redisConfig && !finalOptions.redisClient) {
      throw new Error(
        "Redis configuration or client is required when using redis storage",
      );
    }
    storage = new RedisStorage(
      finalOptions.redisClient || finalOptions.redisConfig!,
    );
  } else {
    storage = new MemoryStorage();
  }

  // Initialize webhook handler
  if (finalOptions.webhook) {
    webhookHandler = new WebhookHandler(finalOptions.webhook);
  }

  return function rateLimit(handler: NextApiHandler): NextApiHandler {
    return async function rateLimitedHandler(
      req: NextRequest,
    ): Promise<NextResponse> {
      // Check if we should skip rate limiting
      if (finalOptions.skip && (await finalOptions.skip(req))) {
        return handler(req) as Promise<NextResponse>;
      }

      // Generate key for rate limiting
      const key = finalOptions.keyGenerator
        ? finalOptions.keyGenerator(req)
        : `${getClientIp(req)}-${req.nextUrl.pathname}`;

      // Get limit for this request
      const limit = finalOptions.getLimitForRequest
        ? await finalOptions.getLimitForRequest(req)
        : finalOptions.limit!;

      const windowMs = finalOptions.windowMs!;

      try {
        // Increment usage from storage
        const usage = await storage.increment(key, windowMs);

        const headers: Record<string, string> = {
          "X-RateLimit-Limit": String(limit),
          "X-RateLimit-Remaining": String(Math.max(0, limit - usage.used)),
          "X-RateLimit-Reset": String(usage.reset),
        };

        // If limit is exceeded
        if (usage.used > limit) {
          const retryAfterSec = Math.max(
            0,
            Math.ceil((usage.reset * 1000 - Date.now()) / 1000),
          );
          headers["Retry-After"] = String(retryAfterSec);

          if (webhookHandler) {
            await webhookHandler.notify(req, { ...usage, limit });
          }

          // Call custom onLimitReached handler if provided
          if (finalOptions.onLimitReached) {
            await finalOptions.onLimitReached(req, { ...usage, limit });
          }

          // Use custom handler or default response
          if (finalOptions.handler) {
            return (await finalOptions.handler(req, {
              ...usage,
              limit,
            })) as NextResponse;
          }

          return NextResponse.json(
            { error: "Too Many Requests" },
            {
              status: 429,
              headers,
            },
          );
        }

        // Call original handler
        const response = (await Promise.resolve(handler(req))) as NextResponse;

        // Attach rate limit headers
        Object.entries(headers).forEach(([k, v]) => {
          response.headers.set(k, v);
        });

        return response;
      } catch (error: unknown) {
        console.error("Rate limiting error:", error);
        // On storage or other errors, allow the request
        return handler(req) as Promise<NextResponse>;
      }
    };
  };
}

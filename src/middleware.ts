import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import type {
  RateLimitOptions,
  StorageAdapter,
  NextApiHandler,
  EdgeConfig,
} from "./types";
import { RateLimitStrategy } from "./types";
import { MemoryStorage } from "./storage/memory";
import { RedisStorage } from "./storage/redis";
import { MongoStorage } from "./storage/mongodb";
import { PostgresStorage } from "./storage/postgresql";
import { EdgeStorage } from "./storage/edge";
import { WebhookHandler } from "./webhook";

function getClientIp(req: NextRequest): string {
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();
  return (
    req.headers.get("x-real-ip") || req.headers.get("x-client-ip") || "unknown"
  );
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Deep merge helper: merges objects recursively, replaces arrays, overrides primitives.
 */
function deepMerge<T = unknown>(target?: Partial<T>, source?: Partial<T>): T {
  if (target === undefined) return (source as T) ?? ({} as T);
  if (source === undefined) return target as T;

  if (Array.isArray(source)) {
    // arrays are replaced
    return source as unknown as T;
  }

  if (!isPlainObject(target) || !isPlainObject(source)) {
    return source as T;
  }

  const out: Record<string, unknown> = {
    ...(target as Record<string, unknown>),
  };
  const src = source as Record<string, unknown>;
  const tgt = target as Record<string, unknown>;

  for (const key of Object.keys(src)) {
    const s = src[key];
    const t = tgt[key];
    if (Array.isArray(s)) {
      out[key] = s;
    } else if (isPlainObject(s) && isPlainObject(t)) {
      out[key] = deepMerge(t as Partial<T>, s as Partial<T>);
    } else {
      out[key] = s;
    }
  }
  return out as unknown as T;
}

/**
 * Simple route matcher supporting:
 * - exact paths ("/api/foo")
 * - wildcard "*" for global override
 * - prefix wildcard like "/api/users/*"
 */
function findRouteOverride(
  map: Record<string, Partial<RateLimitOptions>> | undefined,
  pathname: string,
): Partial<RateLimitOptions> | undefined {
  if (!map) return undefined;
  // exact match
  if (Object.prototype.hasOwnProperty.call(map, pathname)) return map[pathname];
  // prefix wildcard matches (keys ending with "/*")
  for (const key of Object.keys(map)) {
    if (key === "*") return map[key];
    if (key.endsWith("/*")) {
      const prefix = key.slice(0, -1); // keep trailing slash
      if (pathname.startsWith(prefix)) return map[key];
    }
  }
  return undefined;
}

const DEFAULT_OPTIONS: Partial<RateLimitOptions> = {
  limit: 100,
  windowMs: 60 * 1000, // 1 minute
  strategy: RateLimitStrategy.FIXED_WINDOW,
  storage: "memory",
};

export function withRateLimit(options: RateLimitOptions = {}) {
  // Apply defaults (deep merge to allow nested defaults)
  const globalOptions = deepMerge<RateLimitOptions>(
    DEFAULT_OPTIONS as Partial<RateLimitOptions>,
    options,
  );

  return function rateLimit(handler: NextApiHandler): NextApiHandler {
    return async function rateLimitedHandler(
      req: NextRequest,
    ): Promise<NextResponse> {
      // Determine per-route override and merge with globals
      const routeOverrides = (
        globalOptions as Partial<RateLimitOptions> & {
          routes?: Record<string, Partial<RateLimitOptions>>;
        }
      ).routes;
      const matchedOverride = findRouteOverride(
        routeOverrides,
        req.nextUrl.pathname,
      );
      const finalOptions = deepMerge<RateLimitOptions>(
        globalOptions as Partial<RateLimitOptions>,
        matchedOverride,
      );

      let storage: StorageAdapter;
      let webhookHandler: WebhookHandler | undefined;

      // Initialize storage for this (possibly overridden) config
      if (finalOptions.storage === "redis") {
        if (!finalOptions.redisConfig && !finalOptions.redisClient) {
          throw new Error(
            "Redis configuration or client is required when using redis storage",
          );
        }
        storage = new RedisStorage(
          finalOptions.redisClient || finalOptions.redisConfig!,
        );
      } else if (finalOptions.storage === "mongodb") {
        if (!finalOptions.mongoConfig && !finalOptions.mongoClient) {
          throw new Error(
            "MongoDB configuration or client is required when using mongodb storage",
          );
        }
        storage = new MongoStorage(
          finalOptions.mongoClient || finalOptions.mongoConfig!,
        );
      } else if (finalOptions.storage === "postgresql") {
        if (!finalOptions.postgresConfig && !finalOptions.postgresClient) {
          throw new Error(
            "Postgres configuration or client is required when using postgresql storage",
          );
        }
        storage = new PostgresStorage(
          finalOptions.postgresClient || finalOptions.postgresConfig!,
        );
      } else if (finalOptions.storage === "edge") {
        const edgeCfg = (
          finalOptions as RateLimitOptions & { edgeConfig?: EdgeConfig }
        ).edgeConfig;
        if (!edgeCfg) {
          throw new Error(
            "Edge storage configuration is required when using edge storage",
          );
        }
        storage = new EdgeStorage(edgeCfg);
      } else {
        storage = new MemoryStorage();
      }

      // Initialize webhook handler if configured for this route
      if (finalOptions.webhook) {
        webhookHandler = new WebhookHandler(finalOptions.webhook);
      }

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

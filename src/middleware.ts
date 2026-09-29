import type { NextRequest } from "next/server.js";
import { NextResponse } from "next/server.js";
import type {
  RateLimitOptions,
  StorageAdapter,
  NextApiHandler,
} from "./types.js";
import { RateLimitStrategy } from "./types.js";
import { MemoryStorage } from "./storage/memory.js";
import { RedisStorage } from "./storage/redis.js";
import { IORedisStorage } from "./storage/ioredis.js";
import { MongoStorage } from "./storage/mongodb.js";
import { PostgresStorage } from "./storage/postgresql.js";
import { EdgeStorage } from "./storage/edge.js";
import { WebhookHandler } from "./webhook.js";
import { getClientIp } from "./request.js";

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== "object" || v === null) return false;
  const prototype: unknown = Object.getPrototypeOf(v);
  return prototype === Object.prototype || prototype === null;
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
  // The most specific prefix wins regardless of insertion order.
  let bestMatch: Partial<RateLimitOptions> | undefined;
  let bestLength = 0;
  for (const key of Object.keys(map)) {
    if (key.endsWith("/*")) {
      const prefix = key.slice(0, -1); // keep trailing slash
      if (pathname.startsWith(prefix) && prefix.length > bestLength) {
        bestMatch = map[key];
        bestLength = prefix.length;
      }
    }
  }
  return bestMatch ?? map["*"];
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
    type RouteRuntime = {
      options: RateLimitOptions;
      storage: StorageAdapter;
      webhookHandler?: WebhookHandler;
    };
    const runtimes = new Map<
      Partial<RateLimitOptions> | undefined,
      RouteRuntime
    >();

    function getRuntime(override?: Partial<RateLimitOptions>): RouteRuntime {
      const cached = runtimes.get(override);
      if (cached) return cached;

      const finalOptions = deepMerge<RateLimitOptions>(globalOptions, override);
      let storage: StorageAdapter;
      if (finalOptions.storage === "redis") {
        const config = finalOptions.redisClient ?? finalOptions.redisConfig;
        if (!config) {
          throw new Error(
            "Redis configuration or client is required when using redis storage",
          );
        }
        storage = new RedisStorage(config);
      } else if (finalOptions.storage === "ioredis") {
        const config = finalOptions.ioredisClient ?? finalOptions.ioredisConfig;
        if (!config) {
          throw new Error(
            "ioredis configuration or client is required when using ioredis storage",
          );
        }
        storage = new IORedisStorage(config);
      } else if (finalOptions.storage === "mongodb") {
        const config = finalOptions.mongoClient ?? finalOptions.mongoConfig;
        if (!config) {
          throw new Error(
            "MongoDB configuration or client is required when using mongodb storage",
          );
        }
        storage = new MongoStorage(config);
      } else if (finalOptions.storage === "postgresql") {
        const config =
          finalOptions.postgresClient ?? finalOptions.postgresConfig;
        if (!config) {
          throw new Error(
            "Postgres configuration or client is required when using postgresql storage",
          );
        }
        storage = new PostgresStorage(config);
      } else if (finalOptions.storage === "edge") {
        if (!finalOptions.edgeConfig) {
          throw new Error(
            "Edge storage configuration is required when using edge storage",
          );
        }
        storage = new EdgeStorage(finalOptions.edgeConfig);
      } else {
        storage = new MemoryStorage();
      }

      const runtime = {
        options: finalOptions,
        storage,
        webhookHandler: finalOptions.webhook
          ? new WebhookHandler(finalOptions.webhook)
          : undefined,
      };
      runtimes.set(override, runtime);
      return runtime;
    }

    return async function rateLimitedHandler(
      req: NextRequest,
    ): Promise<NextResponse> {
      const matchedOverride = findRouteOverride(
        globalOptions.routes,
        req.nextUrl.pathname,
      );
      const {
        options: finalOptions,
        storage,
        webhookHandler,
      } = getRuntime(matchedOverride);

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

      let usage;
      try {
        usage = await storage.increment(key, windowMs);
      } catch (error: unknown) {
        console.error("Rate limiting error:", error);
        return (await handler(req)) as NextResponse;
      }

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
    };
  };
}

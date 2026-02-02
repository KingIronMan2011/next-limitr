import { createClient, type RedisClientType } from "redis";
import { StorageAdapter, RateLimitUsage, RedisConfig } from "../types";

type ExecReply =
  | number
  | string
  | null
  | Array<unknown>
  | Record<string, unknown>;

/** Type guard to detect a Redis client instance without using `any`. */
function isRedisClient(obj: unknown): obj is RedisClientType {
  if (obj === null || typeof obj !== "object") return false;
  const o = obj as Record<string, unknown>;
  return typeof o["connect"] === "function" && "isOpen" in o;
}

export class RedisStorage implements StorageAdapter {
  private client: RedisClientType;
  private readonly keyPrefix = "next-limitr:";
  private readonly ownsClient: boolean;

  // Lua script for atomic increment + ensure TTL (returns [count, ttl_ms])
  private readonly incrScript = `
    local v = redis.call("INCR", KEYS[1])
    local ttl = redis.call("PTTL", KEYS[1])
    if ttl < 0 then
      redis.call("PEXPIRE", KEYS[1], ARGV[1])
      ttl = ARGV[1]
    end
    return {v, ttl}
  `;

  // Lua script for safe decrement (only decrement if > 0). returns new value or nil.
  private readonly decrScript = `
    local v = redis.call("GET", KEYS[1])
    if not v then return nil end
    local n = tonumber(v)
    if n > 0 then
      return redis.call("DECR", KEYS[1])
    end
    return n
  `;

  constructor(config: RedisConfig | RedisClientType) {
    if (isRedisClient(config)) {
      this.client = config;
      this.ownsClient = false;
    } else {
      const cfg = config as RedisConfig;
      this.client = createClient({
        socket: {
          host: cfg.host,
          port: cfg.port,
          tls: cfg.tls ? true : undefined,
        },
        password: cfg.password,
        database: cfg.db,
      });
      this.ownsClient = true;
      this.client.connect().catch(() => {});
    }
  }

  private getKey(key: string): string {
    return `${this.keyPrefix}${key}`;
  }

  private extractNumberFromReply(reply: ExecReply | undefined): number {
    if (reply === undefined || reply === null) {
      throw new Error("Empty reply from Redis");
    }
    if (typeof reply === "number") return reply;
    if (typeof reply === "string") {
      const parsed = Number(reply);
      if (Number.isFinite(parsed)) return parsed;
    }
    if (Array.isArray(reply)) {
      for (const v of reply) {
        if (typeof v === "number") return v;
        if (typeof v === "string") {
          const p = Number(v);
          if (Number.isFinite(p)) return p;
        }
      }
    }
    if (typeof reply === "object") {
      for (const val of Object.values(reply)) {
        if (typeof val === "number") return val;
        if (typeof val === "string") {
          const p = Number(val);
          if (Number.isFinite(p)) return p;
        }
      }
    }
    const parsed = Number(String(reply));
    if (!Number.isFinite(parsed))
      throw new Error("Invalid numeric reply from Redis");
    return parsed;
  }

  async increment(key: string, windowMs: number): Promise<RateLimitUsage> {
    const redisKey = this.getKey(key);

    // Use atomic Lua script to INCR and ensure PEXPIRE is set
    const evalResult = (await this.client.eval(this.incrScript, {
      keys: [redisKey],
      arguments: [String(windowMs)],
    })) as unknown as ExecReply[] | null;

    if (!evalResult || evalResult.length < 2) {
      throw new Error("Redis transaction failed: empty result");
    }

    // First element is count, second is ttl in ms
    const count = this.extractNumberFromReply(evalResult[0]);
    const ttl = this.extractNumberFromReply(evalResult[1]);

    const effectiveTtl = ttl > 0 ? ttl : windowMs;
    const reset = Math.floor((Date.now() + effectiveTtl) / 1000);

    const limit = Number.MAX_SAFE_INTEGER;
    const remaining = Math.max(limit - count, 0);

    return {
      limit,
      remaining,
      reset,
      used: count,
    };
  }

  async decrement(key: string): Promise<void> {
    const redisKey = this.getKey(key);

    // Atomic decrement only if value > 0
    await this.client.eval(this.decrScript, {
      keys: [redisKey],
      arguments: [],
    });
  }

  async reset(key: string): Promise<void> {
    await this.client.del(this.getKey(key));
  }

  async close(): Promise<void> {
    if (this.ownsClient) {
      await this.client.quit();
    }
  }

  async getActiveKeys(): Promise<string[]> {
    const keys = await this.client.keys(`${this.keyPrefix}*`);
    return keys.map((k) => k.slice(this.keyPrefix.length));
  }
}

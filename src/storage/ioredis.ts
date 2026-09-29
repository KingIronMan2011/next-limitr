import IORedis from "ioredis";
import type { RateLimitUsage, RedisConfig, StorageAdapter } from "../types.js";
const INCREMENT_SCRIPT = `
  local v = redis.call("INCR", KEYS[1])
  local ttl = redis.call("PTTL", KEYS[1])
  if ttl < 0 then
    redis.call("PEXPIRE", KEYS[1], ARGV[1])
    ttl = ARGV[1]
  end
  return {v, ttl}
`;

const DECREMENT_SCRIPT = `
  local v = redis.call("GET", KEYS[1])
  if not v then return nil end
  local n = tonumber(v)
  if n > 0 then
    return redis.call("DECR", KEYS[1])
  end
  return n
`;

type ScriptedClient = IORedis & {
  nextLimitrIncrementV1(key: string, windowMs: number): Promise<unknown>;
  nextLimitrDecrementV1(key: string): Promise<unknown>;
};

const registeredClients = new WeakSet<IORedis>();

function registerScripts(client: IORedis): ScriptedClient {
  if (!registeredClients.has(client)) {
    client.defineCommand("nextLimitrIncrementV1", {
      numberOfKeys: 1,
      lua: INCREMENT_SCRIPT,
    });
    client.defineCommand("nextLimitrDecrementV1", {
      numberOfKeys: 1,
      lua: DECREMENT_SCRIPT,
    });
    registeredClients.add(client);
  }
  return client as ScriptedClient;
}

function isIORedisClient(value: RedisConfig | IORedis): value is IORedis {
  return "eval" in value && typeof value.eval === "function";
}

export class IORedisStorage implements StorageAdapter {
  private readonly client: ScriptedClient;
  private readonly ownsClient: boolean;
  private readonly keyPrefix = "next-limitr:";

  constructor(config: RedisConfig | IORedis) {
    if (isIORedisClient(config)) {
      this.client = registerScripts(config);
      this.ownsClient = false;
    } else {
      this.client = registerScripts(
        new IORedis({
          host: config.host,
          port: config.port,
          password: config.password,
          db: config.db,
          tls: config.tls ? {} : undefined,
          lazyConnect: true,
        }),
      );
      this.ownsClient = true;
    }
  }

  private getKey(key: string): string {
    return `${this.keyPrefix}${key}`;
  }

  async increment(key: string, windowMs: number): Promise<RateLimitUsage> {
    const reply = await this.client.nextLimitrIncrementV1(
      this.getKey(key),
      windowMs,
    );
    if (!Array.isArray(reply) || reply.length < 2) {
      throw new Error("ioredis transaction failed: empty result");
    }

    const count = Number(reply[0]);
    const ttl = Number(reply[1]);
    if (!Number.isFinite(count) || !Number.isFinite(ttl)) {
      throw new Error("Invalid numeric reply from ioredis");
    }

    const effectiveTtl = ttl > 0 ? ttl : windowMs;
    const limit = Number.MAX_SAFE_INTEGER;
    return {
      limit,
      remaining: Math.max(limit - count, 0),
      reset: Math.floor((Date.now() + effectiveTtl) / 1000),
      used: count,
    };
  }

  async decrement(key: string): Promise<void> {
    await this.client.nextLimitrDecrementV1(this.getKey(key));
  }

  async reset(key: string): Promise<void> {
    await this.client.del(this.getKey(key));
  }

  async close(): Promise<void> {
    if (this.ownsClient) {
      if (this.client.status === "wait") {
        this.client.disconnect();
      } else if (this.client.status !== "end") {
        await this.client.quit();
      }
    }
  }

  async getActiveKeys(): Promise<string[]> {
    const keys = new Set<string>();
    let cursor = "0";
    do {
      const [nextCursor, batch] = await this.client.scan(
        cursor,
        "MATCH",
        `${this.keyPrefix}*`,
        "COUNT",
        1000,
      );
      cursor = nextCursor;
      for (const key of batch) keys.add(key.slice(this.keyPrefix.length));
    } while (cursor !== "0");
    return [...keys];
  }
}

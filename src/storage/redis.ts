import { createClient, type RedisClientType } from "redis";
import { StorageAdapter, RateLimitUsage, RedisConfig } from "../types";

export class RedisStorage implements StorageAdapter {
  private client: RedisClientType;
  private readonly keyPrefix: string = "next-limitr:";

  constructor(config: RedisConfig | RedisClientType) {
    // Detect a redis client by presence of sendCommand (runtime check)
    if (config && typeof (config as any).sendCommand === "function") {
      this.client = config as RedisClientType;
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
      // start connecting in background
      this.client.connect().catch(() => {});
    }
  }

  private getKey(key: string): string {
    return `${this.keyPrefix}${key}`;
  }

  async increment(key: string, windowMs: number): Promise<RateLimitUsage> {
    const redisKey = this.getKey(key);
    const now = Date.now();
    const resetTime = now + windowMs;

    // Use Redis multi to ensure atomicity
    const result = await this.client
      .multi()
      .incr(redisKey)
      .pExpire(redisKey, windowMs)
      .exec();

    if (!result || result.length === 0) {
      throw new Error("Redis transaction failed");
    }

    const countResult = result[0] as unknown;
    const count =
      typeof countResult === "number"
        ? countResult
        : parseInt(String(countResult), 10);
    if (isNaN(count)) {
      throw new Error("Invalid count value from Redis");
    }

    return {
      limit: Infinity,
      remaining: Infinity - count,
      reset: Math.floor(resetTime / 1000),
      used: count,
    };
  }

  async decrement(key: string): Promise<void> {
    const redisKey = this.getKey(key);
    const exists = (await this.client.exists(redisKey)) > 0;
    if (exists) {
      await this.client.decr(redisKey);
    }
  }

  async reset(key: string): Promise<void> {
    await this.client.del(this.getKey(key));
  }

  async close(): Promise<void> {
    await this.client.quit();
  }

  // Helper method to get all active rate limit keys
  async getActiveKeys(): Promise<string[]> {
    const keys = await this.client.keys(`${this.keyPrefix}*`);
    return keys.map((key) => key.slice(this.keyPrefix.length));
  }
}

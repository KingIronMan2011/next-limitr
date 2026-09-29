import type { StorageAdapter, RateLimitUsage, EdgeConfig } from "../types.js";
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

interface KVRecord {
  count: number;
  resetAt: number;
}

/**
 * EdgeStorage supports Upstash (REST Redis) and Cloudflare KV.
 * - Upstash path uses the Upstash REST API (single HTTP requests).
 * - Cloudflare path uses KV binding methods (best-effort atomicity).
 */
export class EdgeStorage implements StorageAdapter {
  private readonly keyPrefix = "next-limitr:";

  constructor(private readonly config: EdgeConfig) {}

  private getKey(key: string): string {
    return `${this.keyPrefix}${key}`;
  }

  private async upstashCommand(cmd: string[]): Promise<unknown> {
    if (this.config.kind !== "upstash")
      throw new Error("Upstash config missing");
    const { url, token } = this.config.upstash;
    const res = await fetch(url.replace(/\/+$/, ""), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(cmd),
      signal: AbortSignal.timeout(5_000),
    });
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      throw new Error(`Invalid Upstash response: HTTP ${res.status}`);
    }
    if (!json || typeof json !== "object" || Array.isArray(json)) {
      throw new Error("Invalid Upstash response");
    }
    if ("error" in json) {
      throw new Error(`Upstash command failed: ${String(json.error)}`);
    }
    if (!res.ok) throw new Error(`Upstash request failed: HTTP ${res.status}`);
    if (!("result" in json))
      throw new Error("Upstash response is missing result");
    return json.result;
  }

  private parseNumber(value: unknown): number {
    if (typeof value !== "number" && typeof value !== "string") {
      throw new Error("Invalid numeric reply from Upstash");
    }
    const number = Number(value);
    if (!Number.isFinite(number)) {
      throw new Error("Invalid numeric reply from Upstash");
    }
    return number;
  }

  private readKVRecord(raw: string | null): KVRecord | null {
    if (!raw) return null;
    try {
      const value: unknown = JSON.parse(raw);
      if (!value || typeof value !== "object") return null;
      if (!("count" in value) || !("resetAt" in value)) return null;
      if (
        typeof value.count !== "number" ||
        typeof value.resetAt !== "number" ||
        !Number.isFinite(value.count) ||
        !Number.isFinite(value.resetAt)
      ) {
        return null;
      }
      return { count: value.count, resetAt: value.resetAt };
    } catch {
      return null;
    }
  }

  private async writeKVRecord(key: string, record: KVRecord): Promise<void> {
    if (this.config.kind !== "cloudflare")
      throw new Error("Cloudflare KV missing");
    const secondsUntilReset = Math.ceil((record.resetAt - Date.now()) / 1000);
    await this.config.cf.kv.put(key, JSON.stringify(record), {
      expirationTtl: Math.max(60, secondsUntilReset),
      metadata: { resetAt: record.resetAt },
    });
  }

  async increment(key: string, windowMs: number): Promise<RateLimitUsage> {
    const k = this.getKey(key);

    if (this.config.kind === "upstash") {
      const result = await this.upstashCommand([
        "EVAL",
        INCREMENT_SCRIPT,
        "1",
        k,
        String(windowMs),
      ]);
      if (!Array.isArray(result) || result.length !== 2) {
        throw new Error("Invalid Upstash increment result");
      }
      const count = this.parseNumber(result[0]);
      const ttl = this.parseNumber(result[1]);
      const effectiveTtl = ttl > 0 ? ttl : windowMs;
      const reset = Math.floor((Date.now() + effectiveTtl) / 1000);
      const limit = Number.MAX_SAFE_INTEGER;
      const remaining = Math.max(limit - count, 0);
      return { limit, remaining, reset, used: count };
    }

    const now = Date.now();
    const record = this.readKVRecord(await this.config.cf.kv.get(k, "text"));
    const active = record !== null && record.resetAt > now;
    const next: KVRecord = {
      count: active ? record.count + 1 : 1,
      resetAt: active ? record.resetAt : now + windowMs,
    };
    await this.writeKVRecord(k, next);
    const limit = Number.MAX_SAFE_INTEGER;
    return {
      limit,
      remaining: Math.max(limit - next.count, 0),
      reset: Math.floor(next.resetAt / 1000),
      used: next.count,
    };
  }

  async decrement(key: string): Promise<void> {
    const k = this.getKey(key);
    if (this.config.kind === "upstash") {
      await this.upstashCommand(["EVAL", DECREMENT_SCRIPT, "1", k]);
      return;
    }
    const record = this.readKVRecord(await this.config.cf.kv.get(k, "text"));
    if (!record || record.resetAt <= Date.now() || record.count <= 0) return;
    await this.writeKVRecord(k, { ...record, count: record.count - 1 });
  }

  async reset(key: string): Promise<void> {
    const k = this.getKey(key);
    if (this.config.kind === "upstash") {
      await this.upstashCommand(["DEL", k]);
      return;
    }
    await this.config.cf.kv.delete(k);
  }

  async close(): Promise<void> {}

  async getActiveKeys(): Promise<string[]> {
    const prefix = this.keyPrefix;
    if (this.config.kind === "upstash") {
      const keys = new Set<string>();
      let cursor = "0";
      do {
        const response = await this.upstashCommand([
          "SCAN",
          cursor,
          "MATCH",
          `${prefix}*`,
          "COUNT",
          "1000",
        ]);
        if (
          !Array.isArray(response) ||
          response.length !== 2 ||
          !Array.isArray(response[1])
        ) {
          throw new Error("Invalid Upstash SCAN result");
        }
        cursor = String(response[0]);
        for (const key of response[1]) {
          if (typeof key === "string" && key.startsWith(prefix)) {
            keys.add(key.slice(prefix.length));
          }
        }
      } while (cursor !== "0");
      return [...keys];
    }
    const kv = this.config.cf.kv;
    if (!kv.list) return [];
    const keys: string[] = [];
    const now = Date.now();
    let cursor: string | undefined;
    let complete = false;
    while (!complete) {
      const page = await kv.list({ prefix, cursor });
      keys.push(
        ...page.keys
          .filter((key) => {
            const metadata = key.metadata;
            if (!metadata || typeof metadata !== "object") return true;
            const resetAt = (metadata as { resetAt?: unknown }).resetAt;
            return typeof resetAt !== "number" || resetAt > now;
          })
          .map((key) => key.name.slice(prefix.length)),
      );
      complete = page.list_complete !== false;
      if (complete) break;
      if (!page.cursor || page.cursor === cursor) {
        throw new Error("Cloudflare KV listing did not advance");
      }
      cursor = page.cursor;
    }
    return keys;
  }
}

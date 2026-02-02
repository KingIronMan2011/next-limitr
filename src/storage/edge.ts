import { StorageAdapter, RateLimitUsage, KVNamespaceLike, UpstashConfig, CloudflareConfig } from "../types";

export type EdgeConfig = { kind: "upstash"; upstash: UpstashConfig } | { kind: "cloudflare"; cf: CloudflareConfig };

/**
 * EdgeStorage supports Upstash (REST Redis) and Cloudflare KV.
 * - Upstash path uses the Upstash REST API (single HTTP requests).
 * - Cloudflare path uses KV binding methods (best-effort atomicity).
 */
export class EdgeStorage implements StorageAdapter {
  private readonly keyPrefix = "next-limitr:";
  private readonly kind: EdgeConfig["kind"];
  private readonly upstash?: UpstashConfig;
  private readonly kv?: KVNamespaceLike;

  // Lua scripts reused from redis adapter (works if Upstash supports EVAL)
  private readonly incrScript = `
    local v = redis.call("INCR", KEYS[1])
    local ttl = redis.call("PTTL", KEYS[1])
    if ttl < 0 then
      redis.call("PEXPIRE", KEYS[1], ARGV[1])
      ttl = ARGV[1]
    end
    return {v, ttl}
  `;

  private readonly decrScript = `
    local v = redis.call("GET", KEYS[1])
    if not v then return nil end
    local n = tonumber(v)
    if n > 0 then
      return redis.call("DECR", KEYS[1])
    end
    return n
  `;

  constructor(cfg: EdgeConfig) {
    this.kind = cfg.kind;
    if (cfg.kind === "upstash") {
      this.upstash = cfg.upstash;
    } else {
      this.kv = cfg.cf.kv;
    }
  }

  private getKey(key: string): string {
    return `${this.keyPrefix}${key}`;
  }

  // Helpers for Upstash: send a single command (array of strings) as JSON body.
  private async upstashCommand(cmd: string[]): Promise<unknown> {
    if (!this.upstash) throw new Error("Upstash config missing");
    const url = this.upstash.url.replace(/\/+$/, "") + "/commands";
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(this.upstash.token ? { Authorization: `Bearer ${this.upstash.token}` } : {}),
      },
      body: JSON.stringify(cmd),
    });
    const json = await res.json().catch(() => null);
    return json;
  }

  // Attempt to extract numeric replies from various response shapes.
  private extractNumber(reply: unknown): number {
    if (reply === null || reply === undefined) throw new Error("Empty reply");
    if (typeof reply === "number") return reply;
    if (typeof reply === "string") {
      const n = Number(reply);
      if (Number.isFinite(n)) return n;
    }
    if (Array.isArray(reply) && reply.length > 0) {
      for (const v of reply) {
        const maybe = this.tryParseNumber(v);
        if (maybe !== null) return maybe;
      }
    }
    const maybe = this.tryParseNumber(reply);
    if (maybe !== null) return maybe;
    throw new Error("Invalid numeric reply");
  }

  private tryParseNumber(v: unknown): number | null {
    if (typeof v === "number") return v;
    if (typeof v === "string") {
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    }
    return null;
  }

  async increment(key: string, windowMs: number): Promise<RateLimitUsage> {
    const k = this.getKey(key);

    if (this.kind === "upstash") {
      // Use EVAL script for atomic increment + ensure TTL (best-effort if Upstash supports EVAL)
      const body = ["EVAL", this.incrScript, "1", k, String(windowMs)];
      const json = await this.upstashCommand(body);
      // Upstash REST responses vary; attempt to find returned array [count, ttl]
      // Common shapes: { result: [v, ttl] } or [v, ttl]
      const result = (json as any)?.result ?? (json as any);
      const arr = Array.isArray(result) ? result : (result as unknown[]);
      if (!arr || arr.length < 2) throw new Error("Upstash increment failed");
      const count = this.extractNumber(arr[0]);
      const ttl = this.extractNumber(arr[1]);
      const effectiveTtl = ttl > 0 ? ttl : windowMs;
      const reset = Math.floor((Date.now() + effectiveTtl) / 1000);
      const limit = Number.MAX_SAFE_INTEGER;
      const remaining = Math.max(limit - count, 0);
      return { limit, remaining, reset, used: count };
    }

    // Cloudflare KV fallback: non-atomic best-effort
    if (!this.kv) throw new Error("Cloudflare KV missing");
    const raw = (await this.kv.get(k, "text")) ?? "0";
    const prev = Number(raw) || 0;
    const next = prev + 1;
    // Use expirationTtl (seconds)
    const ttlSec = Math.ceil(windowMs / 1000);
    await this.kv.put(k, String(next), { expirationTtl: ttlSec });
    const reset = Math.floor((Date.now() + ttlSec * 1000) / 1000);
    const limit = Number.MAX_SAFE_INTEGER;
    const remaining = Math.max(limit - next, 0);
    return { limit, remaining, reset, used: next };
  }

  async decrement(key: string): Promise<void> {
    const k = this.getKey(key);
    if (this.kind === "upstash") {
      // Best-effort: call decr Lua via EVAL
      const body = ["EVAL", this.decrScript, "1", k];
      await this.upstashCommand(body);
      return;
    }
    if (!this.kv) throw new Error("Cloudflare KV missing");
    const raw = (await this.kv.get(k, "text")) ?? "0";
    const prev = Number(raw) || 0;
    const next = Math.max(0, prev - 1);
    // Keep existing TTL unknown; set without TTL (best-effort)
    await this.kv.put(k, String(next));
  }

  async reset(key: string): Promise<void> {
    const k = this.getKey(key);
    if (this.kind === "upstash") {
      await this.upstashCommand(["DEL", k]);
      return;
    }
    if (!this.kv) throw new Error("Cloudflare KV missing");
    await this.kv.delete(k);
  }

  async close(): Promise<void> {
    // Edge stores typically don't need explicit close
    return;
  }

  async getActiveKeys(): Promise<string[]> {
    const prefix = this.keyPrefix;
    if (this.kind === "upstash") {
      // Upstash REST doesn't expose keys listing via REST in a stable way; return empty.
      return [];
    }
    if (!this.kv) throw new Error("Cloudflare KV missing");
    if (!this.kv.list) return [];
    const res = await this.kv.list({ prefix });
    return (res.keys || []).map((k) => k.name.slice(prefix.length));
  }
}
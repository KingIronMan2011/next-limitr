import { StorageAdapter, RateLimitUsage } from "../types";

interface MemoryRecord {
  count: number;
  resetTime: number;
}

export class MemoryStorage implements StorageAdapter {
  private storage: Map<string, MemoryRecord>;

  constructor() {
    this.storage = new Map();
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [key, record] of this.storage.entries()) {
      if (now >= record.resetTime) {
        this.storage.delete(key);
      }
    }
  }

  async increment(key: string, windowMs: number): Promise<RateLimitUsage> {
    this.cleanup();

    const now = Date.now();
    const record = this.storage.get(key);
    const limit = Number.MAX_SAFE_INTEGER;

    if (!record || now >= record.resetTime) {
      const resetTime = now + windowMs;
      this.storage.set(key, {
        count: 1,
        resetTime,
      });

      const used = 1;
      const remaining = Math.max(limit - used, 0);

      return {
        limit,
        remaining,
        reset: Math.floor(resetTime / 1000),
        used,
      };
    }

    record.count += 1;
    this.storage.set(key, record);

    const used = record.count;
    const remaining = Math.max(limit - used, 0);

    return {
      limit,
      remaining,
      reset: Math.floor(record.resetTime / 1000),
      used,
    };
  }

  async decrement(key: string): Promise<void> {
    const record = this.storage.get(key);
    if (record && record.count > 0) {
      record.count -= 1;
      this.storage.set(key, record);
    }
  }

  async reset(key: string): Promise<void> {
    this.storage.delete(key);
  }

  async close(): Promise<void> {
    this.storage.clear();
  }
}

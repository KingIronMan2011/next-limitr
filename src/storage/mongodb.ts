import { MongoClient, type Collection, type MongoClientOptions } from "mongodb";
import { StorageAdapter, RateLimitUsage, MongoConfig } from "../types";

export class MongoStorage implements StorageAdapter {
  private client: MongoClient;
  private collection!: Collection<{
    _id: string;
    count: number;
    expireAt?: Date;
  }>;
  private readonly keyPrefix = "next-limitr:";
  private readonly ownsClient: boolean;
  private dbName = "next-limitr";
  private collName = "rate_limits";

  constructor(config: MongoConfig | MongoClient) {
    if (this.isMongoClient(config)) {
      this.client = config;
      this.ownsClient = false;
    } else {
      const cfg = config as MongoConfig;
      const uri =
        cfg.uri ?? `mongodb://${cfg.host ?? "127.0.0.1"}:${cfg.port ?? 27017}`;
      const options: MongoClientOptions = cfg.options ?? {};
      this.client = new MongoClient(uri, options);
      this.ownsClient = true;
      // connect in background
      this.client.connect().catch(() => {});
      // honor optional db/collection from config
      this.dbName = cfg.db ?? this.dbName;
      this.collName = cfg.collection ?? this.collName;
    }

    // If a MongoClient instance was provided, we keep default db/collection names
    // or the caller can configure them by providing a MongoConfig instead.
  }

  private isMongoClient(obj: unknown): obj is MongoClient {
    if (!obj || typeof obj !== "object") return false;
    return typeof (obj as Record<string, unknown>)["db"] === "function";
  }

  private getKey(key: string): string {
    return `${this.keyPrefix}${key}`;
  }

  private async ensureCollection(): Promise<void> {
    if (this.collection) return;

    // Ensure connection using the public API. Calling connect() on an already-connected client is safe.
    if (this.ownsClient) {
      await this.client.connect().catch(() => {});
    }

    const db = this.client.db(this.dbName);
    this.collection = db.collection(this.collName);

    // ensure TTL index on expireAt
    await this.collection
      .createIndex({ expireAt: 1 }, { expireAfterSeconds: 0 })
      .catch(() => {});
  }

  async increment(key: string, windowMs: number): Promise<RateLimitUsage> {
    await this.ensureCollection();
    const redisKey = this.getKey(key);
    const expireAt = new Date(Date.now() + windowMs);

    // Atomic upsert: increment count, set expireAt on insert only.
    const res = await this.collection.findOneAndUpdate(
      { _id: redisKey },
      {
        $inc: { count: 1 },
        $setOnInsert: { expireAt },
      },
      { upsert: true, returnDocument: "after" },
    );

    // normalize result: driver typings may return the doc directly or a wrapper with `.value`
    type DocType = { _id: string; count: number; expireAt?: Date } | null;
    const resObj = res as unknown;
    let doc: DocType = null;

    if (
      resObj &&
      typeof resObj === "object" &&
      "value" in (resObj as Record<string, unknown>)
    ) {
      doc = (resObj as { value?: DocType }).value ?? null;
    } else {
      doc = resObj as DocType;
    }

    if (!doc) throw new Error("MongoDB transaction failed: empty result");

    const count =
      typeof doc.count === "number" ? doc.count : Number(doc.count || 0);
    const effectiveExpire = doc.expireAt ?? expireAt;
    const ttl = Math.max(effectiveExpire.getTime() - Date.now(), 0);
    const reset = Math.floor((Date.now() + ttl) / 1000);

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
    await this.ensureCollection();
    const redisKey = this.getKey(key);

    // Decrement only if count > 0
    await this.collection.updateOne(
      { _id: redisKey, count: { $gt: 0 } },
      { $inc: { count: -1 } },
    );
  }

  async reset(key: string): Promise<void> {
    await this.ensureCollection();
    await this.collection.deleteOne({ _id: this.getKey(key) });
  }

  async close(): Promise<void> {
    if (this.ownsClient) {
      await this.client.close();
    }
  }

  async getActiveKeys(): Promise<string[]> {
    await this.ensureCollection();
    const cursor = this.collection
      .find({ _id: { $regex: `^${this.keyPrefix}` } })
      .project({ _id: 1 });
    const docs = await cursor.toArray();
    return docs.map((d) => d._id.slice(this.keyPrefix.length));
  }
}

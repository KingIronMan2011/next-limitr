import { MongoClient, type Collection, type MongoClientOptions } from "mongodb";
import { StorageAdapter, RateLimitUsage, MongoConfig } from "../types.js";

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
  private collectionPromise?: Promise<void>;

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

  private async initializeCollection(): Promise<void> {
    if (this.ownsClient) await this.client.connect();
    const db = this.client.db(this.dbName);
    this.collection = db.collection(this.collName);
    await this.collection.createIndex(
      { expireAt: 1 },
      { expireAfterSeconds: 0 },
    );
  }

  private ensureCollection(): Promise<void> {
    return (this.collectionPromise ??= this.initializeCollection().catch(
      (error: unknown) => {
        this.collectionPromise = undefined;
        throw error;
      },
    ));
  }

  async increment(key: string, windowMs: number): Promise<RateLimitUsage> {
    await this.ensureCollection();
    const redisKey = this.getKey(key);
    const expired = {
      $lte: [{ $ifNull: ["$expireAt", new Date(0)] }, "$$NOW"],
    };

    // Reset expired windows during the atomic update. TTL deletion is asynchronous.
    const res = await this.collection.findOneAndUpdate(
      { _id: redisKey },
      [
        {
          $set: {
            count: {
              $cond: [expired, 1, { $add: [{ $ifNull: ["$count", 0] }, 1] }],
            },
            expireAt: {
              $cond: [
                expired,
                {
                  $dateAdd: {
                    startDate: "$$NOW",
                    unit: "millisecond",
                    amount: windowMs,
                  },
                },
                "$expireAt",
              ],
            },
          },
        },
      ],
      { upsert: true, returnDocument: "after" },
    );

    // normalize result: driver typings may return the doc directly or a wrapper with `.value`
    type DocType = { _id: string; count: number; expireAt?: Date } | null;
    const resObj = res as unknown;
    let doc: DocType;

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
    if (!doc.expireAt)
      throw new Error("MongoDB transaction failed: missing expiry");
    const reset = Math.floor(doc.expireAt.getTime() / 1000);

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

import { describe, it, expect } from "vitest";
import { MongoClient } from "mongodb";
import { MongoStorage } from "../../src/storage/mongodb";

describe("MongoStorage (integration or mock)", () => {
  const uri = process.env.MONGO_URI;

  it("increments, decrements and resets (real or mocked)", async () => {
    if (uri) {
      const client = new MongoClient(uri);
      await client.connect();
      const storage = new MongoStorage(client);

      const key = `test-mongo-${Date.now()}`;
      const u1 = await storage.increment(key, 2000);
      expect(u1.used).toBeGreaterThanOrEqual(1);

      const u2 = await storage.increment(key, 2000);
      expect(u2.used).toBeGreaterThanOrEqual(u1.used);

      await storage.decrement(key);
      const u3 = await storage.increment(key, 2000);
      expect(u3.used).toBeGreaterThanOrEqual(1);

      await storage.reset(key);
      await storage.close();
      await client.close();
      return;
    }

    // Lightweight in-memory mock MongoClient/Collection to exercise MongoStorage logic.
    class MockCollection {
      private store = new Map<string, { count: number; expireAt: number }>();

      async findOneAndUpdate(
        filter: unknown,
        update: unknown,
        _opts?: unknown,
      ) {
        void _opts;
        const id = (filter as { _id?: string })._id as string;
        const now = Date.now();
        const upd = update as Record<string, unknown> | null;
        const setOnInsert =
          (upd?.["$setOnInsert"] as Record<string, unknown> | undefined) ??
          undefined;
        const expireAtParam =
          (setOnInsert?.["expireAt"] as Date | undefined) ??
          new Date(now + 2000);
        const expireAtMs = expireAtParam.getTime();
        const existing = this.store.get(id);
        if (!existing || existing.expireAt < now) {
          this.store.set(id, { count: 1, expireAt: expireAtMs });
        } else {
          existing.count += 1;
        }
        const doc = this.store.get(id)!;
        return {
          value: {
            _id: id,
            count: doc.count,
            expireAt: new Date(doc.expireAt),
          },
        };
      }

      async updateOne(filter: unknown, _update?: unknown) {
        void _update;
        const id = (filter as { _id?: string })._id ?? (filter as string);
        const gt = (filter as { count?: { $gt?: number } }).count?.$gt;
        const existing = this.store.get(id as string);
        if (existing && (gt === undefined || existing.count > gt)) {
          existing.count = Math.max(0, existing.count - 1);
          return { matchedCount: 1, modifiedCount: 1 };
        }
        return { matchedCount: 0, modifiedCount: 0 };
      }

      async deleteOne(filter: unknown) {
        const id = (filter as { _id: string })._id as string;
        this.store.delete(id);
        return { deletedCount: 1 };
      }

      async createIndex(_spec?: unknown, _opts?: unknown) {
        void _spec;
        void _opts;
        return "ok";
      }

      find(filter: unknown) {
        const prefixRaw =
          ((filter as { _id?: { $regex?: string } })._id?.[
            "$regex"
          ] as unknown) ?? "";
        const prefix = String(prefixRaw).replace("^", "").replace(".*", "");
        const keys = Array.from(this.store.keys()).filter((k) =>
          k.startsWith(prefix),
        );
        return {
          project: () => ({
            toArray: async () => keys.map((k) => ({ _id: k })),
          }),
          toArray: async () => keys.map((k) => ({ _id: k })),
        };
      }
    }

    class MockDb {
      private coll = new MockCollection();
      collection(_name?: string) {
        void _name;
        return this.coll;
      }
    }

    class MockClient {
      private dbInstance = new MockDb();
      async connect() {}
      async close() {}
      db(_name?: string) {
        void _name;
        return this.dbInstance;
      }
    }

    const mock = new MockClient();
    const storage = new MongoStorage(mock as unknown as MongoClient);

    const key = `test-mongo-mock-${Date.now()}`;
    const u1 = await storage.increment(key, 2000);
    expect(u1.used).toBeGreaterThanOrEqual(1);

    const u2 = await storage.increment(key, 2000);
    expect(u2.used).toBeGreaterThanOrEqual(u1.used);

    await storage.decrement(key);
    const u3 = await storage.increment(key, 2000);
    expect(u3.used).toBeGreaterThanOrEqual(1);

    await storage.reset(key);
    await storage.close();
  });
});

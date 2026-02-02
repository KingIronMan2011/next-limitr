import { describe, it, expect } from "vitest";
import { MongoClient } from "mongodb";
import { MongoStorage } from "../../src/storage/mongodb";

describe("MongoStorage (integration)", () => {
  const uri = process.env.MONGO_URI;
  if (!uri) {
    it.skip("skips when MONGO_URI is not set", () => {});
    return;
  }

  it("increments, decrements and resets", async () => {
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
  });
});

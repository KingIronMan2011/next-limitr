import { describe, it, expect } from "vitest";
import { MemoryStorage } from "../../src/storage/memory";

describe("MemoryStorage", () => {
  it("increments, returns usage and resets correctly", async () => {
    const store = new MemoryStorage();
    const usage1 = await store.increment("k1", 1000);
    expect(usage1.used).toBe(1);
    const usage2 = await store.increment("k1", 1000);
    expect(usage2.used).toBe(2);
    await store.reset("k1");
    const usage3 = await store.increment("k1", 1000);
    expect(usage3.used).toBe(1);
  });
});

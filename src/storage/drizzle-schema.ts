import { pgTable, text, bigint, timestamp } from "drizzle-orm/pg-core";

export const rateLimits = pgTable("rate_limits", {
  id: text("id").primaryKey(),
  count: bigint("count", { mode: "number" }).notNull(),
  expireAt: timestamp("expire_at", { withTimezone: true }),
});

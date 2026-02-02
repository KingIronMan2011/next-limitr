import type { NextRequest } from "next/server";
import type { RedisClientType } from "redis";
import type { MongoClient } from "mongodb";
import type { Pool, Client } from "pg";

export enum RateLimitStrategy {
  FIXED_WINDOW = "fixed-window",
  SLIDING_WINDOW = "sliding-window",
  TOKEN_BUCKET = "token_bucket",
}

export type StorageType = "memory" | "redis" | "mongodb" | "postgresql" | "edge";

export type KVNamespaceLike = {
  get(key: string, type?: "text"): Promise<string | null>;
  put(
    key: string,
    value: string,
    options?: { expiration?: number | Date; expirationTtl?: number }
  ): Promise<void>;
  delete(key: string): Promise<void>;
  list?: (opts?: { prefix?: string; limit?: number }) => Promise<{ keys: { name: string }[] }>;
};

export interface RedisConfig {
  host: string;
  port: number;
  password?: string;
  db?: number;
  tls?: boolean;
}

export interface MongoConfig {
  uri?: string;
  host?: string;
  port?: number;
  db?: string;
  collection?: string;
  options?: Record<string, unknown>;
}

export interface PostgresConfig {
  connectionString?: string;
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  database?: string;
  max?: number;
}

export interface UpstashConfig {
  url: string; // e.g. https://us1-xxxxx.upstash.io
  token?: string; // REST token (Bearer)
}

export interface CloudflareConfig {
  kv: KVNamespaceLike;
}

export interface WebhookConfig {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  payload?: (req: NextRequest, usage: RateLimitUsage) => unknown;
}

export interface RateLimitUsage {
  used: number;
  remaining: number;
  reset: number;
  limit: number;
}

export interface RateLimitOptions {
  // Basic options
  limit?: number;
  windowMs?: number;
  strategy?: RateLimitStrategy;

  // Storage options
  storage?: StorageType;
  redisConfig?: RedisConfig;
  redisClient?: RedisClientType;
  mongoConfig?: MongoConfig;
  mongoClient?: MongoClient;
  postgresConfig?: PostgresConfig;
  postgresClient?: Pool | Client;

  // Webhook and alert options
  webhook?: WebhookConfig;
  onLimitReached?: (
    req: NextRequest,
    usage: RateLimitUsage,
  ) => Promise<void> | void;

  // Custom handlers
  handler?: (
    req: NextRequest,
    usage: RateLimitUsage,
  ) => Promise<NextResponseType> | NextResponseType;
  keyGenerator?: (req: NextRequest) => string;
  getLimitForRequest?: (req: NextRequest) => Promise<number> | number;

  // Skip options
  skipIfAuthenticated?: boolean;
  skip?: (req: NextRequest) => Promise<boolean> | boolean;
}

export interface RateLimitHeaders {
  "X-RateLimit-Limit": string;
  "X-RateLimit-Remaining": string;
  "X-RateLimit-Reset": string;
  "Retry-After"?: string;
}

export interface StorageAdapter {
  increment(key: string, windowMs: number): Promise<RateLimitUsage>;
  decrement(key: string): Promise<void>;
  reset(key: string): Promise<void>;
  close(): Promise<void>;
}

// Use type import to avoid direct dependency on NextResponse
type NextResponseType = import("next/server").NextResponse;

export type NextApiHandler = (
  req: NextRequest,
) => Promise<NextResponseType> | NextResponseType;

export type RateLimitedHandler = (
  options: RateLimitOptions,
) => (handler: NextApiHandler) => NextApiHandler;

# @kingironman2011/next-limitr

**This is a fork of the [next-limitr](https://www.npmjs.com/package/next-limitr) package**

A powerful and flexible rate limiting middleware for Next.js API routes, featuring built-in Redis support, webhook notifications, and customizable alerts.

[![npm version](https://badge.fury.io/js/@kingironman2011%2Fnext-limitr.svg)](https://badge.fury.io/js/@kingironman2011%2Fnext-limitr)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![CI](https://github.com/KingIronMan2011/next-limitr/actions/workflows/ci.yml/badge.svg)](https://github.com/KingIronMan2011/next-limitr/actions/workflows/ci.yml)
[![Publish](https://github.com/KingIronMan2011/next-limitr/actions/workflows/npm-publish.yml/badge.svg)](https://github.com/KingIronMan2011/next-limitr/actions/workflows/npm-publish.yml)

## Overview

`@kingironman2011/next-limitr` provides a minimal, configurable middleware for protecting Next.js API endpoints with rate limits. It supports multiple storage backends, dynamic limits, per-route overrides, and webhook notifications when limits are exceeded.

Key capabilities:

- Global defaults with hierarchical per-route overrides
- Multiple storage backends (in-memory, Redis, MongoDB, PostgreSQL, edge KV)
- Dynamic and programmatic limits (per-request)
- Webhook notifications and custom handlers
- Standard rate-limit response headers
- TypeScript-first API

## Installation

```bash
npm install @kingironman2011/next-limitr
# or
yarn add @kingironman2011/next-limitr
# or
pnpm add @kingironman2011/next-limitr
```

## Quick Start

### Basic Usage

```typescript
import { withRateLimit } from "@kingironman2011/next-limitr";
import { NextRequest, NextResponse } from "next/server";

export const GET = withRateLimit({
  limit: 10,
  windowMs: 60000, // 1 minute
})((request: NextRequest) => {
  return NextResponse.json({ message: "Hello World!" });
});
```

### Per-route overrides (hierarchical config)

You can provide global defaults and a routes map to override settings for specific endpoints or prefixes. Nested objects are merged recursively; arrays in overrides replace arrays in the global config.

```typescript
import { withRateLimit } from "@kingironman2011/next-limitr";

export const handler = withRateLimit({
  limit: 100,
  windowMs: 60000,
  storage: "redis",
  redisClient: redisInstance,
  routes: {
    "/api/admin/*": {
      limit: 20,
      storage: "memory",
    },
    "/api/public": {
      limit: 1000,
      skip: (req) => req.headers.get("x-internal") === "1",
    },
  },
})((req) => {
  /* ... */
});
```

In this example:

- Requests to /api/admin/\* use memory storage and a lower limit.
- /api/public uses a large limit and can be skipped conditionally.
- Any fields omitted in a route override inherit from the global options.

## Configuration Options

### Basic Options

| Option     | Type                | Default        | Description                                          |
| ---------- | ------------------- | -------------- | ---------------------------------------------------- |
| `limit`    | `number`            | `100`          | Maximum number of requests allowed within the window |
| `windowMs` | `number`            | `60000`        | Time window in milliseconds                          |
| `strategy` | `RateLimitStrategy` | `FIXED_WINDOW` | Rate limiting strategy                               |

### Storage Options

| Option           | Type                                                         | Default    | Description                                   |
| ---------------- | ------------------------------------------------------------ | ---------- | --------------------------------------------- |
| `storage`        | `"memory" \| "redis" \| "mongodb" \| "postgresql" \| "edge"` | `"memory"` | Storage backend to use                        |
| `redisConfig`    | `RedisConfig`                                                | -          | Redis configuration (required if using Redis) |
| `redisClient`    | `Redis`                                                      | -          | Existing Redis client instance                |
| `mongoConfig`    | `MongoConfig`                                                | -          | MongoDB configuration or client               |
| `postgresConfig` | `PostgresConfig`                                             | -          | PostgreSQL configuration or client            |
| `edgeConfig`     | `EdgeConfig`                                                 | -          | Edge KV configuration (for edge storage)      |

### Advanced Options

| Option               | Type                                                                                 | Description                      |
| -------------------- | ------------------------------------------------------------------------------------ | -------------------------------- |
| `keyGenerator`       | `(req: NextRequest) => string`                                                       | Custom key generation function   |
| `getLimitForRequest` | `(req: NextRequest) => Promise<number> \| number`                                    | Dynamic limit function           |
| `skip`               | `(req: NextRequest) => Promise<boolean> \| boolean`                                  | Skip rate limiting condition     |
| `handler`            | `(req: NextRequest, usage: RateLimitUsage) => Promise<NextResponse> \| NextResponse` | Custom rate limit response       |
| `webhook`            | `WebhookOptions`                                                                     | Webhook configuration for alerts |

Notes on hierarchical merging:

- Objects are merged recursively from global -> route override.
- Arrays in route overrides replace arrays from globals.
- Primitive values in overrides replace global primitives.
- Route patterns support exact paths, prefix wildcards ("/api/foo/_"), and a global "_" key.

## Response Headers

The middleware adds standard rate limit headers to responses:

- `X-RateLimit-Limit`: Maximum requests allowed
- `X-RateLimit-Remaining`: Remaining requests in the current window
- `X-RateLimit-Reset`: Time when the rate limit resets (Unix timestamp)
- `Retry-After`: Seconds until requests can resume (when rate limited)

## Best Practices

1. Choose the right storage:
   - Use `memory` for development or single-instance deployments.
   - Use `redis` (or another persistent adapter) for production and distributed systems.
2. Configure per-route overrides for high-value or sensitive endpoints.
3. Use `getLimitForRequest` to implement tiered quotas (e.g., premium vs free users).
4. Attach monitoring or webhook handlers to receive alerts on rate limit events.

## Contributing

Contributions are welcome. Please follow repository guidelines and open issues or pull requests for improvements.

## Continuous Integration

This project uses GitHub Actions for CI and publishing:

- Formatting, linting, tests, and build verification run on pushes and PRs.
- Publish workflow releases packages to npm and GitHub Packages.

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## Support

- Create an [issue](https://github.com/KingIronMan2011/next-limitr/issues) for bug reports
- Star the repo if you find it useful
- Follow for updates

---

Built with ♥️ for the Next.js community

# TODO

## High priority

- [ ] Add storage adapter: MongoDB
- [ ] Add storage adapter: PostgreSQL
- [ ] Add storage adapter: DynamoDB
- [ ] Add edge-compatible storage adapter (Upstash/Cloudflare KV)
- [ ] Support Next.js Edge runtime (no native redis)
- [ ] Improve Redis backend: atomic Lua scripts for rate operations
- [ ] Add alternative algorithms (token-bucket, leaky-bucket, sliding-window)
- [ ] Expose selectable rate limit strategies in API
- [ ] Implement hierarchical config: global defaults + per-route overrides

## Medium priority

- [ ] Webhook enhancements: retries, backoff, HMAC signing, batching
- [ ] Add observability hooks/metrics (Prometheus/Datadog events)
- [ ] Extend StorageAdapter API (getActiveKeys, info, metrics hooks)
- [ ] Add GitHub Actions: lint, types, tests, build
- [ ] Add integration tests for edge runtime and Redis failure modes
- [ ] Expand README with examples (server, edge, adapters)

## Low priority

- [ ] Add CONTRIBUTING.md and CODE_OF_CONDUCT
- [ ] Add CHANGELOG and release workflow
- [ ] Provide example recipes and SDK helpers (Express, Fastify)
- [ ] Create a local CLI/dev simulator for rate testing

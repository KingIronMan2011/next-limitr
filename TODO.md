# TODO

## High priority

- [x] Add storage adapter: MongoDB
- [x] Add storage adapter: PostgreSQL
- [x] Add edge-compatible storage adapter (Upstash/Cloudflare KV)
- [x] Improve Redis backend: atomic Lua scripts for rate operations
- [x] Implement hierarchical config: global defaults + per-route overrides

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

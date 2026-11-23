# TODO

One maintainer, one list. Add a line when work is found, delete it when it lands.

## Release and desktop packaging
- [ ] Configure Apple Developer ID signing and notarization secrets before publishing signed macOS `.dmg` releases.
- [ ] Configure Windows code-signing certificate secrets before publishing signed `.msi` installers.
- [ ] Verify desktop shell and WidgetKit snapshot integration on clean macOS, Windows, and Linux hosts for `v0.1.0`.

## Security & Supply-Chain Hardening
- [ ] Upgrade transitive Hono and fast-uri overrides to clear bun audit advisories and enforce audit in CI.
- [ ] Enforce outbound destination policy on Cursor/Devin connection probes, expand secret-guard token prefixes, fix least-used combo preview mutation, and harden Cursor H2 pool eviction.

## Performance & Architecture Debt
- [ ] Unify HTTP SSE passthrough into a single-pass scanner and bypass stream tee when no client block rewrite applies.
- [ ] Eliminate redundant post-serialize JSON re-parsing, repeated combo body clones, and synchronous hot-path file I/O.
- [ ] Add SQLite usage summary rollups, trim unused classic/GIF bundle bloat, deduplicate Rust ACL/lock FFI, and break the 9 remaining import cycles.

## Ecosystem & Protocol Parity
- [ ] Add cross-CLI MCP/skills sync, epx:// provider import deep links, and full profile backup/restore.
- [ ] Add zero-overhead heuristic scenario routing (longContext, think, background, webSearch) and EWMA latency load balancing.
- [ ] Preserve per-block Anthropic cache_control across bridges, add virtual-key TPM/expiry/in-flight USD holds, /v1/embeddings, and optional OTLP tracing.

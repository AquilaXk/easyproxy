# TODO

One maintainer, one list. Add a line when work is found, delete it when it lands.

## Release and desktop packaging
- [ ] Configure Apple Developer ID signing and notarization secrets before publishing signed macOS `.dmg` releases.
- [ ] Configure Windows code-signing certificate secrets before publishing signed `.msi` installers.
- [ ] Verify desktop shell and WidgetKit snapshot integration on clean macOS, Windows, and Linux hosts for `v0.1.0`.

## Performance & Architecture Debt
- [ ] Add SQLite usage summary rollups, trim unused classic/GIF bundle bloat, deduplicate Rust ACL/lock FFI, and break the 9 remaining import cycles.

## Ecosystem & Protocol Parity
- [ ] Add cross-CLI MCP/skills sync, epx:// provider import deep links, and full profile backup/restore.
- [ ] Add zero-overhead heuristic scenario routing (longContext, think, background, webSearch) and EWMA latency load balancing.
- [ ] Preserve per-block Anthropic cache_control across bridges, add virtual-key TPM/expiry/in-flight USD holds, /v1/embeddings, and optional OTLP tracing.

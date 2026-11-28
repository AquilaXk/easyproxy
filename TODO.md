# TODO

One maintainer, one list. Add a line when work is found, delete it when it lands.

## Release and desktop packaging
- [ ] Configure Apple Developer ID signing and notarization secrets before publishing signed macOS `.dmg` releases.
- [ ] Configure Windows code-signing certificate secrets before publishing signed `.msi` installers.
- [ ] Verify desktop shell and WidgetKit snapshot integration on clean macOS, Windows, and Linux hosts for `v0.1.0`.

## Test isolation
- [ ] `bun test tests/clients/ tests/claude-integration/ tests/ci-workflows/` in one run fails ~78 `tests/claude-integration/` cases (503s in messages-request-id-endpoint, claude-bridge-pool-dispatch, claude-messages-endpoint, claude-native-affinity) that pass alone; find the state leaking from the earlier directories.
- [ ] Full `bun run test` on macOS exceeds its 900s budget; CI only runs a Linux subset, so nothing gates the full suite.

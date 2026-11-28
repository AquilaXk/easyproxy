# TODO

One maintainer, one list. Add a line when work is found, delete it when it lands.

## Release and desktop packaging
- [ ] Configure Apple Developer ID signing and notarization secrets before publishing signed macOS `.dmg` releases.
- [ ] Configure Windows code-signing certificate secrets before publishing signed `.msi` installers.
- [ ] Verify desktop shell and WidgetKit snapshot integration on clean macOS, Windows, and Linux hosts for `v0.1.0`.

## Test isolation
- [ ] Full `bun run test` on macOS hit its 900s budget (exit 124) in two runs under external CPU load (load 36 to 160, zero idle CPU from other builds); no idle-machine measurement exists yet. On timeout `scripts/test.ts` prints no per-file timings, so the slow files are unidentified. Re-measure on an idle Mac; CI only runs a Linux subset, so nothing gates the full suite.
- [ ] A bare `bun test` over `tests/adapters/step-cli-process-lifecycle.test.ts` after earlier drain-related files fails 5 StepCode drain cases, and a later set hangs in `tests/storage/storage-mutation-race.test.ts` (both pass alone); find the leaking state the same way as the lifecycle drain latch.

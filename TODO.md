# TODO

One maintainer, one list. Add a line when work is found, delete it when it lands.

## Release and desktop packaging
- [ ] Add the Apple Developer ID account and its six signing secrets later; until then macOS `.dmg` releases ship unsigned and not notarized (all six empty passes the release gate, a partial set fails it).
- [ ] Add the SignPath account (`SIGNPATH_API_TOKEN` plus three repository variables, policy `release-signing`) later; until then `.msi` and standalone `epx.exe` ship unsigned.
- [ ] Verify desktop shell and WidgetKit snapshot integration on clean macOS, Windows, and Linux hosts for `v0.1.0`.

## Test isolation
- [ ] Full `bun run test` on macOS hit its 900s budget (exit 124) in two runs under external CPU load (load 36 to 160, zero idle CPU from other builds); no idle-machine measurement exists yet. On timeout `scripts/test.ts` prints no per-file timings, so the slow files are unidentified. Re-measure on an idle Mac; CI only runs a Linux subset, so nothing gates the full suite.
- [ ] A bare `bun test` over `tests/adapters/step-cli-process-lifecycle.test.ts` after earlier drain-related files fails 5 StepCode drain cases, and a later set hangs in `tests/storage/storage-mutation-race.test.ts` (both pass alone); find the leaking state the same way as the lifecycle drain latch.

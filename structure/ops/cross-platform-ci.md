# Cross-platform CI

The [desktop membership contract](../runtime.md#codex-desktop-process-membership) has adapter regression coverage on every host and real PowerShell prefilter regression coverage with synthetic CIM rows on Windows in `tests/clients/desktop-app-restart.test.ts`. A skipped Windows lane does not exercise that native filter; uid-dependent POSIX cases in `tests/clients/desktop-app-restart-posix.test.ts` are skipped on Windows.

`.github/workflows/ci.yml` triggers on pushes to `main`, pull requests to `main`, and manual
`workflow_dispatch` runs with three jobs:

- **`gates` (`ubuntu-latest`)**: runs `scripts/check-repo-hygiene.ts` (scoped to `BASE_SHA..HEAD_SHA` when `BASE_SHA` is reachable), `bun run audit:high`, moderate dependency audits (`bun audit --audit-level=moderate` at root and `gui`), `bun run typecheck`, `bun run typecheck:tsc`, `bun run privacy:scan`, `bun run structure:check`, `bun run skill:surface:check`, `bun run docs:clients:check`, `scripts/release-version-sources.ts check`, `scripts/generate-update-trust-root.ts --check`, GUI lint/test/build, explicit contract tests (`tests/test-layout.test.ts`, `tests/test-layout-tooling.test.ts`, `tests/ci-workflows/`, `tests/lab/core-lab-boundary.test.ts`, `tests/update/`, `tests/lib/spend-*.test.ts`), and `scripts/ci/run-changed-tests.sh` with `BASE_SHA` passed from the event context.
- **`docs` (`ubuntu-latest`)**: installs `docs-site` frozen dependencies and executes `bun run --cwd docs-site build` (including Astro internal-link verification across rendered pages).
- **`cross-platform` (`linux-x64`, `darwin-arm64`, `windows-x64`)**: builds and tests native Rust helpers (`native/remote-workspace-helper`, `native/epx-child`), builds `gui/dist` and standalone `epx` bundles via `scripts/build-standalone.ts`, verifies `SHA256SUMS` and `__keyring-load-check` smoke runs, and runs platform desktop/native tests (`./tests/windows` on Windows, `MenuBarCoreTests` + `NativeTrayTests` on macOS, and `cargo test --locked --manifest-path desktop/src-tauri/Cargo.toml --lib -- --test-threads=1` on all three OSes).

Dedicated security and release guards run in `.github/workflows/dependency-audit.yml` (Bun high-severity audit + `cargo audit` across every tracked `*Cargo.lock`) and `.github/workflows/latest-guard.yml` (`scripts/ci/latest-guard.ts` verifies `releases/latest` points to the newest published stable `vX.Y.Z` release), while `tests/ci-workflows/workflow-refs.test.ts` checks every path, `bun run` target, and commit-pinned external action across `.github/workflows/` and `.github/actions/`.

`scripts/ci/run-changed-tests.sh` computes the merge base from `BASE_SHA` (falling back to `HEAD^1` only when `BASE_SHA` is empty, all-zeros, or absent locally), executes `bun scripts/test.ts --changed=<base>` while excluding `api-storage-policy*.test.ts`, `api-storage.test.ts`, and `api-usage.test.ts` from the shared pool, and then executes those excluded families in dedicated fresh `bun scripts/test.ts` processes whenever storage, usage, or management paths change, followed by `./tests/ci-workflows/file-size-ratchet.test.ts`.

For duration-weighted sharded execution, `scripts/ci/run-bun-test-batches.sh` balances files using
`scripts/ci/test-durations.tsv` (Linux/macOS) and `scripts/ci/test-durations.windows.tsv` (Windows, selected by `RUNNER_OS`, or overridden by `BUN_TEST_DURATIONS_FILE`). A batch closes before its predicted duration passes half the process timeout, `scripts/ci/test-durations.ts refresh` regenerates duration tables from hosted logs, and `EPX_TEST_NO_QUEUE=1` disables the user-scoped queue inside sequential batches while per-process home isolation and live-home guards stay active.
Release verification (`scripts/release.ts`) checks green `ci.yml` runs on `main`.
Test teardown follows the [sandbox cleanup contract](test-sandbox-cleanup.md).
`tests/preload.ts` resolves cleanup dependencies after home/lock admission and before test cases; teardown awaits native-main startup releases and config hardening, then the sandbox's registered ACL child reaps before removing that root. Its synchronous exit fallback leaves an undrained root for ownership-checked stale recovery instead of blocking child cleanup with removal retries. `tests/ci-workflows/test-sandbox-cleanup.test.ts` pins that ordering with a delayed reap.
`tests/helpers/test-sandbox-cleanup.ts` exposes case-scoped lifecycle ownership: cancellation starts listener stops while owned asynchronous work settles, and repeated close/stop calls share one promise. After teardown starts, only the lifecycle's own abort reason is absorbed; any other error, including a foreign AbortError, still fails its case. Callers settle that lifecycle before draining producers/reaps and restoring or removing a home. The helper does not replace fixture-specific cleanup or claim OS ACL coverage for synthetic tests.
A test failure, a process timeout, and a Bun runtime crash each fail execution on the first occurrence; `scripts/ci/run-bun-test-batches.sh` sweeps a crashed or timed-out batch one file per process only to attribute the failure the shard has already taken.
Test sandboxes keep the runner's `LOCALAPPDATA`, so Windows PowerShell 5.1 children reuse the
image's warm module-analysis cache. Replacing it with a freshly built seed made every child
re-analyze modules and timed out seven shards on the first run of #6670.
`scripts/test.ts` pins the default `BUN_RUNTIME_TRANSPILER_CACHE_PATH` beneath its exclusively
created test root, in a `bun-transpiler-cache` directory (mode 0700 on POSIX). Cached JavaScript is
executable input, so the runner never adopts, repairs, migrates or deletes the old fixed host-TEMP
cache. Nested sandboxes and fixture children inherit the owning environment's cache even when
HOME changes; only that owner's cleanup removes it. Separate environments and CI batches start
with separate caches. This gives up automatic cross-batch reuse: cold Windows startup coverage
must be evaluated without raising test deadlines or weakening assertions. An explicit override,
including "" or "0" to disable caching, is preserved and remains the operator's protected-path
responsibility. `tests/ci-workflows/test-runner.test.ts` covers isolation, legacy-path refusal,
cleanup ownership, overrides and actual Bun children with different homes.
The published launcher (`bin/epx.mjs`) starts the bundled Bun, which is not the test-runner Bun.
Bun keys `.pile` entries by source hash and deletes an entry written in another release's format,
so the two versions sharing one cache evict each other on every start, and each launcher child
loaded its CLI graph cold (a 15 s Windows `spawnSync` timeout in run 38697651428). The launcher
therefore passes its child a `bun-<version>` leaf appended beneath the configured cache
(`src/lib/bun-transpiler-cache-scope.mjs`); `tests/cli/bun-transpiler-cache-scope.test.ts`
covers it.
Server children started on the bundled runtime from a different Bun (startup-health probe,
dashboard startup install, Windows tray) get the same scope through `durableBunChildEnv` in
`src/lib/bun-runtime.ts`. Scoping never leaves the configured path: when the path's own leaf is
already `bun-<version>` of the runtime being started it is kept unchanged, and a changed version
nests one more `bun-<version>` level beneath it.
Startup ACL reads use .NET, never module-autoloaded `Get-Acl`/`Set-Acl`
(verified across `src/`).
Local `bun run typecheck` uses the installed Bun runtime's native checker with the root
`tsconfig.json`, strict options and `src/` scope. `--no-script` prevents a future package `check`
script from replacing type checking, and the command emits no files. `bun run typecheck:tsc`
retains the installed TypeScript compiler for comparison and fallback. CI and release preflight
invoke `tsc` directly; GUI build checks and the separate `testRunnerBun` pin keep their own roles.
The `prepublishOnly` hook runs `typecheck:tsc` after `audit:high` and before `build:gui`,
stopping on either audit or compiler failure.
Across the jobs, the workflow runs:

```bash
bun install --frozen-lockfile
bun x tsc --noEmit
bun test --isolate tests
bun run privacy:scan
bun build scripts/release.ts --target=bun --outdir=.tmp/ci-release-script-check
cd gui && bun install --frozen-lockfile && bun run lint && bun run build
bun run src/cli/index.ts help
```

and the Node-only global-install smoke path:

```bash
npm install
npm run build:gui
npm pack --json > pack.json
npm install -g ./easyproxy-*.tgz
epx help
```

`deploy-docs.yml` builds the Astro documentation site separately. CI does not run coverage or perform remote Ubuntu/RDP smoke tests.
Those stay outside the default gate until a concrete regression justifies the extra runtime.

The manual Release workflow selects a source with qualifying green CI runs on `main` and
uses a separately identified trusted workflow revision. Publication remains gated by tag or explicit `dry-run: false` dispatch. History
reconciliation and the attested resume follow the [release workflow](docs-and-release.md#release-workflow).
Review of the legacy history mapping, security review, actual dry-run evidence and cutover settings
remain open; a CI run alone does not authorize publication.

The shared Responses path follows the [bounded multipart recovery contract](../subagents.md#multipart-encrypted-task-recovery); credential admission and retry policy remain unchanged.

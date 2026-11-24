# Heuristic Scenario Routing and EWMA Latency Load Balancing

## Overview

EasyProxy adds two opt-in routing optimizations with zero request-path overhead when disabled:

1. **Zero-overhead heuristic scenario routing** (`longContext`, `think`, `background`, `webSearch`) configured via `config.scenarioRouting`.
2. **EWMA latency load balancing** (`strategy: "ewma-latency"`) for combos, tracking exponential weighted moving average latency and failure penalties per target.

## Scenario Routing Contract

- **Disabled fast path**: When `config.scenarioRouting?.enabled !== true` or `config.scenarioRouting.routes` defines no non-empty targets, `classifyRequestScenario` returns immediately in $O(1)$ without scanning headers or request bodies, and HTTP handlers avoid materializing optional lazy body projections.
- **Bounded single-pass scanning**: When enabled, `src/routing/scenario.ts` walks top-level fields (`instructions`, `system`, `input`, `messages`, `tools`, `thinking`, `reasoning`, `output_config`, `metadata`, `background`) and headers (`x-epx-priority`, `x-epx-scenario`) in a single bounded pass (`MAX_SCAN_ITEMS = 512`, `MAX_SCAN_PARTS_PER_ITEM = 32`, `MAX_SCAN_TOOLS = 64`), with no full JSON re-serialization and early exit once the `longContext` character budget is reached. Base64 data URLs and media blocks count as bounded fixed estimates rather than raw byte counts.
- **Explicit route preservation**: Unless `overrideExplicitRoutes: true` is configured, explicit `combo/*`, `policy/*`, and Codex account-namespace selectors (`<ns>/<model>`) bypass scenario rewrites. Configuration and bounds validation live in `src/config/schema/scenario-routing.ts`.
- **Credential-domain and bridge parity**: Cross-target scenario rewrites set `credentialDomainRewrite: true`, attach bounded `scenario` metadata on `RouteDecisionTraceV1`, and pass `scenarioMatchOverride` across `/v1/chat/completions` and `/v1/messages` bridges to `/v1/responses` so preflight admission scope and final upstream dispatch agree.
- **Management and CLI parity**: `src/server/management/scenario-routing-routes.ts` exposes `GET /api/routing/scenario`, `PUT /api/routing/scenario`, `DELETE /api/routing/scenario`, and `POST /api/routing/scenario/classify`, paired with `epx agent scenario-routing <show|set|clear|classify>` in `src/cli/agent-scenario-routing.ts`. All target selectors fail closed on write if unresolvable or disabled.

## EWMA Latency Load Balancing Contract

- **Cold-start exploration**: `src/combos/ewma.ts` distributes unmeasured targets (fewer than `minSamples`) round-robin via a generation-scoped cursor; `preview: true` inspections never mutate exploration cursors or EWMA scores.
- **Exponential weighted scoring and decay**: Each successful completion updates $ewma_{t+1} = \alpha \cdot sample + (1 - \alpha) \cdot ewma_t$ (with optional `halfLifeMs` time decay), weighted by `1 / target.weight`, bounded to `[1, 600000]` ms samples and capped at `MAX_EWMA_ENTRIES = 4096`.
- **Failure penalty and stale recovery**: Upstream failures penalize the target (`errorPenaltyMs` scaled by consecutive failures) alongside existing cooldown state, while stale observations decay toward the fresh target median so previously degraded targets can re-enter after recovery.
- **State lifecycle**: Reconciled and cleared on config generation changes via `reconcileComboEwmaState` and `clearComboEwmaState` inside `src/combos/resolve.ts`.

## Invariants

- <a id="INV-SCENARIO-ZERO-OVERHEAD"></a>`INV-SCENARIO-ZERO-OVERHEAD`: Disabled or empty `scenarioRouting` never scans request bodies; enabled scanning stays strictly item/part/tool-bounded and never amplifies base64 media payloads into `longContext`.
- <a id="INV-EWMA-PREVIEW-ISOLATION"></a>`INV-EWMA-PREVIEW-ISOLATION`: `ewma-latency` preview selections never mutate EWMA statistics or exploration cursors, and removed combos/targets purge their EWMA state on generation reconciliation.

## Tests

- [tests/routing/scenario-routing.test.ts](../tests/routing/scenario-routing.test.ts) — covers `INV-SCENARIO-ZERO-OVERHEAD` across disabled fast path, base64 media bounding, hostile item caps, all four scenarios, cross-surface HTTP routing, fail-closed schema validation, management API, and CLI parity.
- [tests/routing/ewma-latency-combo.test.ts](../tests/routing/ewma-latency-combo.test.ts) — covers `INV-EWMA-PREVIEW-ISOLATION`, cold-start rotation, adaptive EWMA convergence, weighted scoring, failure penalties, stale recovery, reconciliation, CLI/management config, and live HTTP multi-turn dispatch.

# Third-Party Software Notices

EasyProxy's own source code is licensed under the repository `LICENSE` (MIT License, Copyright (c) 2026 AquilaXk).
This file lists direct third-party runtime, UI, and desktop dependencies used by EasyProxy and their licenses.

## Runtime & Proxy Dependencies (`package.json`)

| Package | License | Repository |
| :--- | :--- | :--- |
| `@bufbuild/protobuf` | Apache-2.0 | https://github.com/bufbuild/protobuf-es |
| `@modelcontextprotocol/sdk` | MIT | https://github.com/modelcontextprotocol/typescript-sdk |
| `@napi-rs/keyring` | MIT | https://github.com/Brooooooklyn/keyring-node |
| `bun` | MIT | https://github.com/oven-sh/bun |
| `wreq-js` | MIT | https://github.com/0x676e67/wreq-js |
| `zod` | MIT | https://github.com/colinhacks/zod |

## Dashboard Dependencies (`gui/package.json`)

| Package | License | Repository |
| :--- | :--- | :--- |
| `@fontsource-variable/geist` | OFL-1.1 / MIT | https://github.com/fontsource/font-files |
| `@fontsource-variable/geist-mono` | OFL-1.1 / MIT | https://github.com/fontsource/font-files |
| `@tanstack/react-virtual` | MIT | https://github.com/TanStack/virtual |
| `clsx` | MIT | https://github.com/lukeed/clsx |
| `react` / `react-dom` | MIT | https://github.com/facebook/react |
| `tailwind-merge` | MIT | https://github.com/dcastil/tailwind-merge |
| `wanted-sans` | OFL-1.1 | https://github.com/wanteddev/wanted-sans |

## Desktop Shell & Native Helper Crates (`desktop/src-tauri/Cargo.toml`, `native/*/Cargo.toml`)

| Crate | License | Repository |
| :--- | :--- | :--- |
| `base64` | MIT OR Apache-2.0 | https://github.com/marshallpierce/rust-base64 |
| `dbus` | Apache-2.0 OR MIT | https://github.com/diwic/dbus-rs |
| `hmac` | MIT OR Apache-2.0 | https://github.com/RustCrypto/MACs |
| `reqwest` | MIT OR Apache-2.0 | https://github.com/seanmonstar/reqwest |
| `serde` / `serde_json` | MIT OR Apache-2.0 | https://github.com/serde-rs/serde |
| `sha2` | MIT OR Apache-2.0 | https://github.com/RustCrypto/hashes |
| `tauri` / `tauri-build` / `tauri-utils` | Apache-2.0 OR MIT | https://github.com/tauri-apps/tauri |
| `tauri-plugin-*` | Apache-2.0 OR MIT | https://github.com/tauri-apps/plugins-workspace |
| `tokio` | MIT | https://github.com/tokio-rs/tokio |
| `toml_edit` | MIT OR Apache-2.0 | https://github.com/toml-rs/toml |
| `uuid` | Apache-2.0 OR MIT | https://github.com/uuid-rs/uuid |
| `windows-sys` | MIT OR Apache-2.0 | https://github.com/microsoft/windows-rs |
| `winreg` | MIT | https://github.com/gentoo90/winreg-rs |

## Reference Designs & Attributions (MIT / Apache-2.0)

| Reference | License | Applied Scope |
| :--- | :--- | :--- |
| `anomalyco/opencode` (https://github.com/anomalyco/opencode) | MIT | Model metadata and pricing table conventions (`src/usage/`). |
| `tribgames/mixdog` (https://github.com/tribgames/mixdog) | Apache-2.0 | Usage token-mix and expandable provider-to-model breakdown patterns (`gui/src/components/v2-usage/`), 128-cell context composition and cache-prefix inspection (`src/lib/context-inspector.ts`, `gui/src/components/ContextInspectorPanel.tsx`), Anthropic cache breakpoint TTL ordering and per-turn cache-preserving effort overrides (`src/lib/prompt-cache-injection.ts`, `src/routing/scenario.ts`), device-pixel hairline tokens (`gui/src/design/theme.css`), line-boundary excerpt snapping, and cross-turn identical non-error tool-output deduplication (`src/lib/tool-output-compression.ts`). |
| `BerriAI/litellm` (https://github.com/BerriAI/litellm) & `rtk-ai/rtk` (https://github.com/rtk-ai/rtk) | MIT / Apache-2.0 | Provider-aware `cache_control` injection point conventions (`src/lib/prompt-cache-injection.ts`) and diff/stack-trace-safe repetitive CLI/build/test output & passing-test-run folding (`src/lib/tool-output-compression.ts`). |
| `can1357/oh-my-pi` (https://github.com/can1357/oh-my-pi) | MIT | Anthropic Slow Mode / Grace Allowance header normalization & opt-in 5h-exhausted slow fallback (`src/adapters/anthropic/slow-mode.ts`, `src/oauth/anthropic-slow-fallback.ts`, `src/oauth/anthropic-routing.ts`), multi-provider credit/balance/budget exhaustion discrimination (`src/lib/credit-budget-refusal.ts`), OpenAI Responses cache-preserving `configuration_update` per-message effort injector (`src/adapters/openai-responses/per-message-effort.ts`), OMP remote export compatibility/header wiring (`src/clients/config-export/omp.ts`), and `/v1/rerank` & `/v1/audio/speech` data-plane request shapes (`src/server/rerank.ts`, `src/server/audio-speech.ts`). |
| `earendil-works/pi` (https://github.com/earendil-works/pi) | MIT | Pi remote `$VAR` admission header export conventions (`src/clients/config-export.ts`, `src/clients/config-export/constants.ts`) and pure manual prompt-cache breakeven diagnostic math (`src/lib/context-inspector.ts`). |
| `router-for-me/CLIProxyAPI` (https://github.com/router-for-me/CLIProxyAPI) | MIT | macOS DarkWake / `pmset -g systemstate` graphics+network readiness guard for background OAuth refresh and quota probes (`src/lib/macos-power-state.ts`). |
| `maximhq/bifrost` (https://github.com/maximhq/bifrost) | Apache-2.0 | Opt-in non-Anthropic gateway `defer_loading` (`tool_search`) BM25/`select:` discovery and bounded multi-turn loop emulation (`src/responses/gateway-tool-search.ts`). |
| `farion1231/cc-switch` (https://github.com/farion1231/cc-switch) | MIT | Anthropic `thinking.budget_tokens` and `max_tokens` invariant pre-rectification & 400 recovery (`src/adapters/anthropic/thinking-rectifier.ts`). |
| `Portkey-AI/gateway` (https://github.com/Portkey-AI/gateway) | MIT | `/v1/rerank` and `/v1/audio/speech` gateway data-plane route contracts (`src/server/rerank.ts`, `src/server/audio-speech.ts`). |
| `anthropics/anthropic-sdk-typescript` (https://github.com/anthropics/anthropic-sdk-typescript) | Apache-2.0 | Official 2026 `AnthropicBeta` allowlist/known-beta synchronization (`src/adapters/anthropic/beta-allowlist.ts`). |
| Open-source API gateway reference patterns | MIT | Integer microdollar per-key daily spend budgets (`src/server/api-key-budget.ts`), outbound secret detection/redaction (`src/lib/outbound-secret-guard.ts`), bounded JSON tool-output minification and compression (`src/lib/tool-output-compression.ts`), prompt-cache retention forwarding (`src/chat/inbound.ts`, `src/adapters/openai-chat/passthrough.ts`), and read-only guardrail dry-run previews (`src/server/management/guardrails-routes.ts`). |

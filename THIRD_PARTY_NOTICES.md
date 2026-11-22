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

## Reference Designs & Attributions (MIT)

| Reference | License | Applied Scope |
| :--- | :--- | :--- |
| `anomalyco/opencode` (https://github.com/anomalyco/opencode) | MIT | Model metadata and pricing table conventions (`src/usage/`). |
| Open-source API gateway reference patterns | MIT | Integer microdollar per-key daily spend budgets (`src/server/api-key-budget.ts`), outbound secret detection/redaction (`src/lib/outbound-secret-guard.ts`), tool-output compression (`src/lib/tool-output-compression.ts`), and read-only guardrail dry-run previews (`src/server/management/guardrails-routes.ts`). |

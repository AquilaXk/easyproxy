---
title: Installation
description: Install the easyproxy (epx) proxy, its prerequisites, and verify it runs.
---

easyproxy installs two equivalent command names, `epx` and `easyproxy`. Both launch the same small
local HTTP server (built on Bun). Model requests go to the provider selected by routing; optional
vision and web-search sidecars can also use your ChatGPT login when a routed model needs them.

## Desktop terminal command

A stable EasyProxy Desktop install configures `epx` for new terminals when the app starts. Open a new terminal and run `epx status` or `epx doctor` to inspect the first executable on PATH. On macOS and Linux deb installs, a managed block at the end of zsh, bash and fish startup files puts `~/.easyproxy-desktop/bin` first on PATH and uses the Desktop-owned shim. Windows puts the bundled `epx.exe` install directory first in the user `Path`. Existing terminals, aliases, shell caches and later PATH changes can still select another command; a conflicting Windows system PATH entry can also win. Use the app’s Terminal command settings to repair, disable or remove this configuration. AppImage is excluded.

On macOS and Linux, a current npm/pnpm package launcher that still runs delegates eligible commands to the Desktop CLI when its record is enabled and passes ownership, permission and file-safety checks. Windows has no package-launcher handoff: new terminals select the Desktop `epx.exe` through user `Path` order. A `record-unsafe` error means the record or its directory failed a safety check. Open EasyProxy Desktop to repair the terminal command, or use `EPX_NO_DESKTOP_HANDOFF=1` for a package invocation on macOS/Linux. Package update/removal and internal inspection keep their existing path. `EPX_NO_DESKTOP_HANDOFF=1` suppresses that package handoff for one invocation; it does not change a direct Desktop shim or PATH configuration.

With an enabled Desktop command record, eligible macOS/Linux package-launcher calls stop if
the selected Desktop executable is missing or cannot start; they do not silently run the
npm/pnpm implementation. This can briefly interrupt commands during app replacement. Repair
or disable the terminal command in Desktop, or explicitly use `EPX_NO_DESKTOP_HANDOFF=1`
for one package invocation. That bypass does not repair the Desktop record, shim or PATH.

## Prerequisites

| Requirement | Why |
| --- | --- |
| **[Node](https://nodejs.org) ≥ 18** | `epx` runs on the Bun runtime, but the runtime is bundled automatically by the npm or pnpm install — you do **not** need to install Bun yourself. |
| **[OpenAI Codex](https://openai.com/codex)** (CLI, App, or SDK) | The client easyproxy sits in front of. easyproxy writes to `$CODEX_HOME/config.toml` (default `~/.codex/config.toml`). |
| A provider account or API key | Anthropic, xAI, Kimi, Ollama Cloud, OpenRouter, an OpenAI-compatible endpoint, or your ChatGPT login. |

## Install

```bash
npm install -g --allow-scripts=bun easyproxy
```

With pnpm 10.4 or later:

```bash
pnpm add -g --allow-build=bun easyproxy
```

:::note[npm blocked the bun postinstall?]
Recent npm versions may block bun's postinstall script (`npm warn
install-scripts ... blocked because they are not covered by allowScripts`),
which leaves the bundled Bun runtime unprepared. After trying permitted bundled-runtime
recovery, the launcher can use an executable Bun from an absolute PATH directory if its
stable version has the pinned major and a version at least the pinned version. With the current
1.4.4 dependency, that means 1.4.4 or newer within major 1. Bounded version-policy and identity
checks require `bun --version` to match `bun -e`'s `Bun.version`. On POSIX, the launcher checks
the whole candidate path, including ancestor directories and components reached through
symlinks. Each traversed directory and symlink, and the resolved executable, must be owned by
root or the launcher's effective user. Directories and the resolved executable must not be
group- or world-writable; symlink permission bits are not used. Shared writable ancestors
such as `/tmp` are rejected even with the sticky bit, so protecting only the executable and
its immediate parent is insufficient. A one-line stderr notice names the selected Bun version.
Bun is still bundled; installing it yourself is optional.

If no runtime works, the error still includes “the `bun` dependency is not installed” when
the dependency is missing. On macOS, it also names an executable Desktop CLI found at
`/Applications/EasyProxy.app/Contents/MacOS/epx` or
`~/Applications/EasyProxy.app/Contents/MacOS/epx`. You can invoke that path explicitly;
the package launcher does not delegate automatically or install a PATH shim.

To repair the bundled runtime, reinstall allowing bun's script. Always include the package
name: npm's abbreviated suggestion omits it and would reinstall the current directory:

```bash
npm install -g --allow-scripts=bun easyproxy

# if the original install used sudo, keep using sudo:
sudo npm install -g --allow-scripts=bun easyproxy
```

On Windows a running proxy keeps `node_modules\bun\bin` open, so a manual
`npm install -g` fails with `EBUSY`. `epx update` stops the proxy and restarts the service itself;
for a manual reinstall, stop it first (`epx stop`), install, then restart through the owning service
(`epx service restart`) or `epx start` when unmanaged. `epx doctor` prints this sequence when it finds
a package install whose bundled runtime never unpacked.
:::

Verify both command aliases are on your `PATH`:

```bash
epx --version
easyproxy --version
```

Before start, stop, restart, service, or an update handled by the Bun CLI, a brief stderr
notice can identify a CLI/proxy version mismatch. It is advisory and preserves the command's
exit code; JSON and help output do not trigger it. npm/pnpm updates handled by the Node launcher
before the Bun CLI starts do not emit this notice. `epx status`, `epx doctor`, and `epx resolve`
already report version skew through their diagnostics.

If you install the background service from a shell using fnm, nvm, mise, asdf, or volta,
EasyProxy leaves shell-local multishell directories out of the service PATH. On Linux it
selects a durable `epx` launcher when available; otherwise it uses the package's Bun
runtime. Run `epx service repair` after an older service was installed from a temporary
multishell directory. On macOS, repair reloads launchd when it changes the saved plist.

## Standalone binary (no npm)

Release downloads also include a standalone `epx` binary for supported macOS, Linux, and Windows
targets. It includes the Bun runtime and dashboard, so npm, Node, and a separate Bun installation
are not required. Download the archive for your platform, extract it, and run:

```bash
./epx --version
./epx start
```

The extracted `gui/dist` and `keyring` directories must stay beside the binary. The first serves
the dashboard; the second carries the platform-native OS credential-store binding.

On Windows, [Windows Code Signing](/reference/code-signing/) explains how `epx.exe` is signed and
how to verify it.

### Release channels

The stable `latest` channel already includes GPT-5.6 Sol/Terra/Luna catalog support for ChatGPT,
OpenAI API-key, OpenRouter, and experimental Cursor routes. Upstream access is still account-gated;
the catalog entries do not grant access by themselves. Use the preview channel only to test
unreleased easyproxy builds:

```bash
npm install -g --allow-scripts=bun easyproxy@preview
epx update --tag preview
```

## Run from source

To hack on easyproxy itself:

Building from a source checkout requires a separate Bun executable on PATH before running `bun install`. The npm package exposes `epx` and `easyproxy`, not a global `bun` command.

```bash
git clone https://github.com/AquilaXk/easyproxy.git
cd easyproxy
bun install
bun run dev:proxy   # starts the proxy API in dev mode (src/cli/index.ts start)
bun run dev:gui     # starts the dashboard dev server (another terminal)
```

`bun run dev` remains an alias for `bun run dev:proxy`. The proxy API exposes `/healthz`,
`/v1/responses`, and `/api/*`; `GET /` serves the packaged dashboard only after `bun run build:gui`
has produced `gui/dist`. While hacking on the dashboard, run the frontend separately with
`bun run dev:gui`.

## What gets created

easyproxy state lives under `$EASYPROXY_HOME` (default `~/.easyproxy`). Codex integration files live
under `$CODEX_HOME` (default `~/.codex`).

| Path | Purpose |
| --- | --- |
| `$EASYPROXY_HOME/config.json` | Your providers, default provider, port, and options. |
| `$EASYPROXY_HOME/epx.pid` | PID of the running proxy (single-instance guard). |
| `$EASYPROXY_HOME/runtime-port.json` | The live PID, hostname, and port — including an OS-assigned port when `config.port` is `0`. |
| `$EASYPROXY_HOME/auth.json` | Stored OAuth credentials (when you `epx login`). |
| `$EASYPROXY_HOME/catalog-backup*.json` | Codex model catalog backups made before easyproxy edits it. |
| `$CODEX_HOME/config.toml` | On loopback, easyproxy adds a marker-owned root `openai_base_url`; non-loopback binds use `model_provider = "easyproxy"` plus `[model_providers.easyproxy]` so Codex can send the API-auth header. |
| `$CODEX_HOME/easyproxy.config.toml` | Fallback/reference profile written alongside the main Codex config. |
| `$CODEX_HOME/easyproxy-catalog.json` | Synced native and routed model catalog used by Codex. |

:::note
easyproxy preserves your Codex configuration. On the owning standalone instance, `epx stop`, `epx restore` and `epx eject` remove the managed lines and restore native Codex. A connected Hub client keeps its routing, and stopping a sibling leaves shared client configuration unchanged. See [lifecycle and ownership](/reference/cli/lifecycle/#runtime-ownership) before relying on restoration.
:::

## Next

Continue to the [Quickstart](/getting-started/quickstart/) to configure your first provider,
or read [How It Works](/getting-started/how-it-works/) for the architecture.

<p align="center">
  <img
    src="https://raw.githubusercontent.com/AquilaXk/easyproxy/main/desktop/src-tauri/icons/icon.png"
    width="80"
    alt="EasyProxy"
  >
</p>

<h1 align="center">EasyProxy</h1>

<p align="center">
  One local gateway for your AI coding tools and models.
  <br>
  Use the models you choose with Codex, Claude Code, Claude Desktop and Grok Build, or connect OpenCode, Pi, Qoder, WorkBuddy, Kilo, Cline, T3 Code and more through managed configs.
  <br>
  <a href="#quick-start"><b>Install ↓</b></a> · <a href="https://easyproxy.me/reference/client-support/"><b>Supported tools →</b></a>
</p>

<p align="center">
  <a href="https://github.com/AquilaXk/easyproxy/releases/latest/download/EasyProxy-windows-x64.msi"><img src="assets/download-windows.svg" alt="Download for Windows (.msi)" height="48"></a>
  &nbsp;
  <a href="https://github.com/AquilaXk/easyproxy/releases/latest/download/EasyProxy-macos-arm64.dmg"><img src="assets/download-macos.svg" alt="Download for macOS Apple Silicon (.dmg)" height="48"></a>
  &nbsp;
  <a href="https://github.com/AquilaXk/easyproxy/releases/latest/download/EasyProxy-linux-x86_64.AppImage"><img src="assets/download-linux.svg" alt="Download for Linux (.AppImage)" height="48"></a>
  <br>
  <sub>macOS button is for Apple Silicon (arm64). <a href="https://github.com/AquilaXk/easyproxy/releases/latest/download/EasyProxy-macos-x64.dmg">macOS Intel (.dmg)</a> · <a href="https://github.com/AquilaXk/easyproxy/releases/latest/download/EasyProxy-linux-amd64.deb">Linux (.deb)</a> · <a href="https://github.com/AquilaXk/easyproxy/releases/latest">All release files &amp; checksums</a></sub>
</p>

<p align="center">
  <a href="https://github.com/AquilaXk/easyproxy/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/AquilaXk/easyproxy/actions/workflows/ci.yml/badge.svg?branch=main&style=flat-square"></a>
  <a href="https://github.com/AquilaXk/easyproxy/releases/latest"><img alt="Release" src="https://img.shields.io/github/v/release/AquilaXk/easyproxy?style=flat-square"></a>
  <a href="https://www.npmjs.com/package/easyproxy"><img alt="npm" src="https://img.shields.io/npm/v/easyproxy?style=flat-square"></a>
  <a href="https://github.com/AquilaXk/easyproxy/blob/main/LICENSE"><img alt="License" src="https://img.shields.io/badge/license-MIT-blue?style=flat-square"></a>
  <a href="https://github.com/sponsors/AquilaXk"><img alt="GitHub Sponsors" src="https://img.shields.io/github/sponsors/AquilaXk?style=flat-square&logo=githubsponsors&label=Sponsors"></a>
</p>

<p align="center">
  <a href="README.md">English</a> · <a href="readme/README.fr.md">Français</a> · <a href="readme/README.ko.md">한국어</a> · <a href="readme/README.zh-CN.md">简体中文</a> · <a href="readme/README.zh-TW.md">繁體中文</a> · <a href="readme/README.ru.md">Русский</a> · <a href="readme/README.ja.md">日本語</a> · <a href="readme/README.tr.md">Türkçe</a> · 📖 <a href="https://easyproxy.me/"><b>Full documentation →</b></a>
</p>

```bash
npm install -g --allow-scripts=bun easyproxy
epx start
```

<table>
<tr>
<td width="50%" valign="middle">

### Claude Code, running any model

The picker is stock Claude Code. The model behind it is yours to choose.

</td>
<td width="50%">
  <img src="assets/claude-code-models.gif" alt="Claude Code running a routed model through easyproxy, with gpt-5.6-luna-medium active in the status bar" width="100%">
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### Codex, running any model

Pick a provider and keep your usual workflow.

</td>
<td width="50%">
  <img src="https://raw.githubusercontent.com/AquilaXk/easyproxy/main/assets/demo.gif" alt="easyproxy demo running a task in the Codex app on a routed non-OpenAI model" width="100%">
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### Claude Desktop, running any model

Opus answers, then hands the task to a GPT-5.6 Sol subagent.

</td>
<td width="50%">
  <img src="https://raw.githubusercontent.com/AquilaXk/easyproxy/main/assets/claude-desktop-subagent.gif" alt="Claude Desktop answering as Claude Opus 4.8, then dispatching a GPT-5.6 Sol subagent through easyproxy" width="100%">
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### Grok Build, running any model

Sol drives the session and calls a Kimi K3 subagent.

</td>
<td width="50%">
  <img src="https://raw.githubusercontent.com/AquilaXk/easyproxy/main/assets/grok-build-subagent.gif" alt="Grok Build running GPT-5.6 Sol through easyproxy and calling a Kimi K3 subagent" width="100%">
</td>
</tr>
</table>

easyproxy is a lightweight local gateway between your coding tools and your model providers. It
accepts the Responses, Chat Completions and Anthropic Messages APIs and translates each request into
whatever your provider speaks, carrying streaming, tool calls, reasoning and images where the client,
model and provider support them. Use Claude, Gemini, Grok, GLM, DeepSeek, Kimi, Qwen, Ollama and other
providers with Codex, Claude Code, Claude Desktop, Grok Build and the tools listed on the
[client support page](https://easyproxy.me/reference/client-support/).

## Highlights

- **Use any LLM with Codex, Claude Code, Claude Desktop, and Grok Build.** 40+ built-in providers,
  each keeping the tool's native UI.
- **Combos.** Group providers behind one virtual model id with failover or weighted round-robin. See
  the [combo guide](https://easyproxy.me/guides/combos/).
- **Sub-agents on any model.** Expose routed models in Codex's sub-agent picker, with v1/v2 surface
  control and fallback chains. See the
  [sub-agent guide](https://easyproxy.me/guides/sub-agent-surface/).
- **Log in once or bring an API key.** OAuth for xAI, Anthropic, and Kimi; forwarded `codex login`;
  pasted API keys; or `${ENV_VAR}` references.
- **Web search and vision sidecars.** Non-OpenAI models get real web search and image understanding
  through a sidecar over your ChatGPT login.
- **Live dashboard and logs.** Inspect providers, OAuth status, model selection, and a live request
  log with cache token counts.
- **Clean exit.** `epx stop` restores Codex to its original configuration.
- **Bounded memory ownership.** Every long-lived cache, ring buffer, and protocol-translation store
  has a finite cap, byte budget, or active reconciliation. No unbounded `Map` or `Set` survives a
  config reload.

<details>
<summary>Memory ownership details</summary>

EasyProxy tracks process-retained state in the categories below. Each has a documented bound:

- **15 retained stores** (request log, debug rings, image cache, model cache, vision
  descriptions, cursor blobs, responses continuation, etc.) are byte-accounted and
  evicted by the app-owned memory budget (default 256 MiB), except the native control replay
  store, which is pinned and never evicted.
- **4 observed buffers** (translator accumulators, image/OAuth/Grok tails) are
  monitored for in-flight byte pressure without eviction.
- **32 state-store registrations** handle expiry sweeps (60 s interval) and
  config-generation reconciliation so stale provider/account keys are removed.
- **Path and fingerprint memos** (workspace metadata, hardened identities, installation
  salts, mode-hint capabilities) use insertion-order LRU caps (8–128 entries).
- **Model-cache generation tombstones** are deleted after reconciliation; a global
  generation increment prevents stale in-flight discoveries from repopulating removed
  providers.
- **Lab event-id deduplication** runs under a ledger lock from disk, with no
  process-level RAM index.

Run `GET /api/system/memory` (with the admin token) to inspect live retained bytes,
eviction counters, and watchdog samples.

</details>

## Quick start

### Personal install (CLI)

```bash
npm install -g --allow-scripts=bun easyproxy   # Node 18+; the Bun runtime is bundled automatically
epx start                         # proxy + dashboard on localhost:10100
```

Use `epx service` to run it in the background.

Open **http://localhost:10100** and configure everything in the web dashboard: add providers
(40+ built-ins, or any OpenAI-compatible endpoint), pick models, and manage accounts. `epx gui`
re-opens the dashboard at any time.

### Connect your tool

Connect the tool you already use:

| Tool | How to connect |
|---|---|
| Codex | Turn on the Codex switch on the dashboard's **Route** page, then run `codex` as usual. On a local listener this points Codex's built-in provider at the proxy. From the terminal, run `epx init` before adding providers in the dashboard and accept its Codex prompt. |
| Claude Code | With the `claude` CLI installed, run `epx claude`. It starts the proxy if needed and launches Claude Code through it. |
| Claude Desktop | Run `epx claude desktop`. On a new install it sets up the gateway profile for the whole app; an existing first-party setup is kept, and `epx claude desktop apply --gateway` switches explicitly. See the [Claude Code guide](https://easyproxy.me/guides/claude-code/). Fully quit and reopen Claude Desktop after a switch. |
| Grok Build | On a local listener with Grok integration enabled, `epx start` registers the models when `~/.grok` exists; pick an `epx-*` model in Grok Build. Remote setups: see the [Grok Build guide](https://easyproxy.me/guides/grok-build/). After adding providers, restart the proxy (or run `epx ensure` when Codex autostart is enabled) to refresh the list. |
| Tools with a managed integration | Use the dashboard **Route** page, or `epx integration client enable --client <id>`. |
| Any other tool | Set a custom OpenAI-compatible base URL of `http://localhost:10100/v1`, or an Anthropic base URL of `http://localhost:10100`. |

The [client support page](https://easyproxy.me/reference/client-support/) lists which path each tool has
and which protocol it speaks.

<details>
<summary><b>Desktop app (beta)</b></summary>

The desktop app runs the same proxy and dashboard in a native window, with a tray and bundled `epx`.
It attaches to a proxy that is already running, or starts its bundled one, and the dashboard stays
on the proxy port (**http://localhost:10100** unless you configured another). Pick the file for your
platform from the [latest release](https://github.com/AquilaXk/easyproxy/releases/latest):

| Platform | File | Notes |
|---|---|---|
| macOS 14+ (Apple Silicon) | `EasyProxy-<version>-macos-arm64.dmg` | Signed and notarized when Apple Developer ID credentials are configured; otherwise unsigned (macOS Gatekeeper may require right-click → **Open**) |
| macOS 14+ (Intel) | `EasyProxy-<version>-macos-x64.dmg` | Separate Intel x64 build; same Gatekeeper note when unsigned |
| Windows (x64) | `EasyProxy-<version>-windows-x64.msi` | Code signing via SignPath Foundation is rolling out ([code signing policy](https://easyproxy.me/reference/code-signing/)); until a release is signed, SmartScreen asks once: choose **More info → Run anyway** |
| Linux (x86_64) | `EasyProxy-<version>-linux-x86_64.AppImage` or `-linux-amd64.deb` | The tray needs an AppIndicator-capable desktop |

Every file has a `.sha256` next to it on the release page, and unversioned installer filenames (`EasyProxy-macos-arm64.dmg`, `EasyProxy-macos-x64.dmg`, `EasyProxy-windows-x64.msi`, `EasyProxy-linux-x86_64.AppImage`, `EasyProxy-linux-amd64.deb`) point to the same verified builds on `/releases/latest`. On macOS 14+ the app also ships a
WidgetKit extension that shows proxy status, today's usage and provider quotas; the snapshot model
it renders lives in [`app/`](./app) (`MenuBarCore`). To build the app yourself, run
`bun install && bun run build:gui` at the repository root, then in `desktop/` run
`bun install && bun run prepare-sidecar && bun run prepare-widget && bun run build:local` on macOS,
or `bun install && bun run prepare-sidecar && bun run build:local` on Windows and Linux (the widget
step needs macOS). The [Desktop App guide](https://easyproxy.me/guides/desktop-app/) and the
[macOS Menu Bar App guide](https://easyproxy.me/guides/macos-menu-bar/) cover first launch, and
[`CLI_CONSENT.md`](./CLI_CONSENT.md#where-things-are-installed) lists everything written to disk.

</details>

<details>
<summary><b>Supported platforms</b></summary>

| OS | Status | Service manager | Desktop app (beta) |
|---|---|---|---|
| macOS (arm64 / x64) | Fully supported | launchd | `arm64` / `x64` `.dmg` |
| Linux (x64 / arm64) | Fully supported | systemd (user unit) | x86_64 `.AppImage` / `.deb` |
| Windows (x64) | Fully supported | Task Scheduler (hidden) / opt-in native service (`--native`, WinSW) | x64 `.msi` |

The CLI install requires [Node](https://nodejs.org) 18+; the desktop app needs neither Node nor Bun. The Bun runtime is bundled on `npm install`, so no separate Bun install is needed and Windows needs no WSL. If npm blocked the bundled runtime's install scripts, see the [installation docs](https://easyproxy.me/getting-started/installation/).

</details>

<details>
<summary><b>Docker Compose</b></summary>

The repository ships a digest-pinned, non-root Compose build. The build generates and verifies the
canonical compatibility manifest from the selected Git snapshot. A local clone needs Git and
Docker Compose; a remote Git context needs Docker Compose. Neither path needs host Bun or a
preparation step. Initialize the data-plane token once through stdin and start the hub:

```bash
git clone https://github.com/AquilaXk/easyproxy.git
cd easyproxy
docker compose build
openssl rand -hex 32 | docker compose run --rm -T hub bun run docker/bootstrap-token.ts
docker compose up -d
curl --fail --silent http://127.0.0.1:10100/healthz
curl --fail --silent http://127.0.0.1:10100/readyz
```

The default host binding is `127.0.0.1:10100`. Remote exposure requires explicit
`EASYPROXY_BIND_ADDRESS=<LAN-or-Tailscale-IP> docker compose up -d`; `0.0.0.0` opts into
all host interfaces. Restrict access with a firewall and an authenticated TLS/tailnet frontend.
The generated JSON stays untracked. The build context admits only `.git/index` and `.git/HEAD`, the
inventory `git ls-files` reads (about 1 MB rather than the full object store), and they are visible
only to the build-only manifest stage through a read-only mount, so no `COPY` includes `.git`. An existing host-generated manifest
is still accepted only after validation; otherwise the build generates one itself. The build rejects
stale manifests, missing or mismatched files, extra source files, and symlinks.
It checks every recorded SHA-256 against the build context and copied runtime files, including
`package.json`, `bun.lock`, and the specifically included `scripts/model-metadata.source.json`.

A remote Git context needs BuildKit to retain Git metadata. This Compose build fragment selects the
remote snapshot and passes the required built-in argument:

```yaml
services:
  hub:
    pull_policy: build
    build:
      context: https://github.com/AquilaXk/easyproxy.git#main
      dockerfile: Dockerfile
      target: runtime
      args:
        BUILDKIT_CONTEXT_KEEP_GIT_DIR: "1"
```

The token and mutable state stay in the `epx-state` named volume; no credential is placed in the
image, Compose file, environment, or shell arguments. See the
[Remote Hub deployment guide](https://easyproxy.me/guides/remote-hub/#docker-compose) for provider
setup, authenticated acceptance checks, remote management, and rollback.

</details>

<details>
<summary><b>Install from source (latest main)</b></summary>

**macOS / Linux:**

```bash
curl -fsSL https://bun.sh/install | bash
git clone -b main https://github.com/AquilaXk/easyproxy.git
cd easyproxy && ~/.bun/bin/bun install
~/.bun/bin/bun run build:gui
~/.bun/bin/bun run src/cli/index.ts start
```

**Windows (PowerShell):**

```powershell
irm bun.sh/install.ps1 | iex
git clone -b main https://github.com/AquilaXk/easyproxy.git
cd easyproxy; bun install
bun run build:gui
bun run src/cli/index.ts start
```

Source install runs the latest `main` branch. Memory ownership
patches, runtime GC improvements, and unreleased fixes are available here before
they reach the npm package.

</details>

<details>
<summary><b>For agents</b></summary>

```bash
npm install -g --allow-scripts=bun easyproxy
epx start     # or `epx service`
epx init      # interactive setup: writes ~/.easyproxy/config.json and wires Codex
```

`epx init` never starts the proxy; start it first (or after: either order works, though headless
commands like `epx provider add` and `epx combo set` talk to the **live** proxy and exit nonzero
when it is unreachable). `epx status` / `epx doctor` / `epx health` report the running state.

> **Agents installing or running easyproxy:** read
> [`CLI_CONSENT.md`](./CLI_CONSENT.md). An interactive `epx start` may ask once whether to
> star this repository. That is the user's decision, never an agent's. The CLI suppresses the
> prompt for agent-driven runs and the API refuses them with `403 agent_consent_required`.

</details>

## Model routing

Target any configured provider and model with the `provider/model` syntax:

```bash
codex -m "anthropic/claude-opus-5" "Explain this stack trace"
codex -m "google/gemini-3-pro" "Write unit tests for auth.ts"
codex -m "ollama/llama3" "Refactor this function"
```

Omit the `provider/` prefix to use the default provider or auto-match by model name pattern.
Provider model ids containing `/` are exposed with inner slashes aliased to `-`; the raw
full-slash form keeps working too. Details: [model routing docs](https://easyproxy.me/guides/model-routing/).

<details>
<summary><b>JEV Auto routing (optional)</b></summary>

TypeSafe JEV can choose the first model and reasoning effort for an opt-in Combo while the normal
model picker and every direct route stay unchanged. Add the credential with `epx login jev`, from
**Providers → TypeSafe JEV → Add API key**, or through `TYPESAFE_API_KEY`/`JEV_API_KEY`. Then open
**Models → Combos → Create JEV Auto**, choose the allowed target models, and check the exact efforts
JEV may select for each target. Leaving a target's effort setting untouched allows all efforts that
model currently advertises.

JEV is consulted only for `jev-auto` and only once per logical model call. Missing credentials,
network failures, or invalid decisions fail open to the first currently eligible target; caller
cancellation still cancels the request. Automated tests use a mocked TypeSafe endpoint and do not
validate a live JEV account.

A JEV Combo can instead ask a self-hosted decision model, such as Ollama's keyless `tev1`: add a
`jev-decision` provider whose `baseUrl` is the full `/v1/systemone` endpoint and set the Combo's
`decisionProvider` to it. TypeSafe credentials are never sent there. Details:
[System One-compatible server](https://easyproxy.me/guides/combos/#system-one-compatible-server).

</details>

## Providers & adapters

OpenAI (ChatGPT login or API key), Anthropic, Google Gemini, xAI, Kimi, Azure OpenAI, Ollama
(local + Cloud), Cursor (experimental), and every OpenAI-compatible endpoint, plus DeepSeek,
Groq, OpenRouter, OpenGateway, Together, Fireworks, Cerebras, Mistral, Hugging Face, NVIDIA NIM, MiniMax,
Qwen Cloud, Qoder Global and CN (official PAT + CLI), SiliconFlow, and more. Full list: `epx init` or the
[provider docs](https://easyproxy.me/guides/providers/).

## CLI

```bash
epx init                       # interactive setup (writes config, wires Codex, offers the shim)
epx start [--port 10100] [--socks5 [host:port] | --socks5-off]  # SOCKS5 defaults to socks5://127.0.0.1:10808
epx stop                       # stop + restore native Codex
epx service [install|repair|restart|start|stop|status|uninstall|remove]  # background service
epx codex-shim install         # start the proxy on demand whenever `codex` launches
epx health [--json]            # check immediate proxy liveness
epx ready [--json] [--wait [--timeout <seconds>]]  # check post-sync readiness
epx status                     # is the proxy running?
epx gui                        # open the web dashboard
epx provider <...>             # manage providers (list/add/edit/test/remove)
epx account <...>              # manage ChatGPT accounts & API-key pools
epx combo <...>                # manage failover / round-robin combos
epx v2 <...>                   # multi-agent v1/v2 surface controls
epx update [--tag preview]     # update easyproxy
```

A start whose preferred port is busy stops and names the holder instead of moving to another port,
so it can never leave a second proxy running beside the first. Free the port, or name a different
one with `--port`. Full reference: [CLI docs](https://easyproxy.me/reference/cli/).

<details>
<summary><b>Health and readiness</b></summary>

`GET /healthz` reports immediate proxy liveness. The unauthenticated `GET /readyz` endpoint reports
post-sync readiness with the sanitized JSON identity `{service, version, uptime, pid, port, status}`.
It returns `200` when `status` is `ready`; `pending` and terminal `failed` return `503` with
`Retry-After: 1`.

`epx ready [--json] [--wait [--timeout <seconds>]]` performs one probe by default. `--wait` polls
for up to 45 seconds by default, but exits immediately when it observes terminal `failed`;
`--timeout <seconds>` sets a 1–300 second limit, requires `--wait`, and accepts only positive integers. CLI `--json` output is
`{ready, status, pid, port}`, where `status` is `ready`, `pending`, `failed`, or `unreachable`.

| Exit | Result |
| --- | --- |
| `0` | Ready |
| `1` | Not ready: pending, failed, timeout, or unreachable |
| `64` | Invalid arguments |

An older proxy without `/readyz` fails closed as `unreachable` with exit 1, while `epx health`
remains compatible.

</details>

### Autostart: service vs shim

Use the **service** (`epx service`) for an always-on proxy that restarts on crash. Use the
**shim** (`epx codex-shim install`) for lightweight, on-demand startup without a background
daemon. Remove them with `epx service uninstall` / `epx codex-shim uninstall`.

### Uninstall

```bash
epx uninstall                  # stop, remove service/shim, restore native Codex, clean up state
npm uninstall -g easyproxy
```

## Remote access

By default easyproxy binds to `127.0.0.1` and needs no extra authentication. Binding beyond
loopback (`"hostname": "0.0.0.0"`) **requires** a bearer token: the proxy refuses to start
without `EASYPROXY_API_AUTH_TOKEN`, and every client request must carry it as
`x-easyproxy-api-key`. Details: [configuration reference](https://easyproxy.me/reference/configuration/).

<details>
<summary><b>ChatGPT account pool (advanced)</b></summary>

Self-hosted options for power users. Review each provider's terms before you enable them.

easyproxy can manage a **ChatGPT account pool** for Codex auth. Add multiple ChatGPT / Codex accounts and
refresh their 5h / weekly / 30d quota in the dashboard. Under quota routing, new sessions can use
the lowest-usage healthy account; round-robin and fill-first use their own policies. Existing Codex
threads normally retain affinity to the account that started them, so long SSH, tmux, or
mobile-connected sessions do not jump accounts mid-conversation, though quota re-evaluation, failover,
account exclusion, affinity expiry, or 401/403 and 429 recovery can rebind them. Give the accounts a
selection order when one of them (such as your Codex Desktop login) should only be used once the
others are drained.

- **Pool ChatGPT accounts:** thread affinity, quota-aware auto-switching, cooldown, and
  fail-closed auth handling.

  > **Provider-policy note:** Account pooling is for routing and operational resilience only; it does
  > not guarantee protection from provider rate limits, enforcement, suspension, or other account
  > actions. EasyProxy does not endorse using additional accounts to circumvent provider limits or
  > sharing account credentials between people. You are responsible for complying with each
  > provider's current terms. See the
  > [Codex Auth account-pool guidance](https://easyproxy.me/guides/web-dashboard/#codex-auth-and-account-pools)
  > and [OpenAI's current Terms of Use](https://openai.com/policies/terms-of-use/).

</details>

## Development

Source development requires the `bun` CLI on your `PATH`. The published npm package bundles its own
Bun runtime for installed `epx` commands; package scripts may also resolve Bun through that bundled dependency.

```bash
git clone https://github.com/AquilaXk/easyproxy.git
cd easyproxy
bun install
bun run typecheck
bun run test
```

## Documentation

The public docs are built from [`docs-site/`](./docs-site) and published to **[easyproxy.me](https://easyproxy.me/)**:

- [Installation](https://easyproxy.me/getting-started/installation/)
- [Providers](https://easyproxy.me/guides/providers/)
- [Model routing](https://easyproxy.me/guides/model-routing/)
- [Combos](https://easyproxy.me/guides/combos/)
- [Sub-agent surface](https://easyproxy.me/guides/sub-agent-surface/)
- [Web dashboard](https://easyproxy.me/guides/web-dashboard/)
- [Desktop app](https://easyproxy.me/guides/desktop-app/)
- [Remote Hub deployment](https://easyproxy.me/guides/remote-hub/)
- [CLI reference](https://easyproxy.me/reference/cli/)
- [Configuration reference](https://easyproxy.me/reference/configuration/)

Maintainer source-of-truth notes live under [`structure/`](./structure) and security reporting in [`SECURITY.md`](./SECURITY.md).
Report undisclosed vulnerabilities privately through
[GitHub private vulnerability reporting](https://github.com/AquilaXk/easyproxy/security/advisories/new),
not a public issue.
That form is the only technical channel; there is no security email. Follow-ups stay in the
private report itself, and a public issue may carry coordination only, never vulnerability details.
Acknowledging a report is not the same as triaging it, and no first-response target is promised.

## Feedback

Found a bug or missing a feature? [Open an issue](https://github.com/AquilaXk/easyproxy/issues) or check the [documentation](https://easyproxy.me/). If EasyProxy saves you time, a star helps others find it.

## Sponsor

EasyProxy is free and open source. Sponsorship pays for development time and the model tokens used for testing: [github.com/sponsors/AquilaXk](https://github.com/sponsors/AquilaXk).

### Supporters

Your name here — [become a sponsor](https://github.com/sponsors/AquilaXk).

## Code signing policy

Windows binaries are moving to Authenticode signing. The [Windows Code Signing guide](https://easyproxy.me/reference/code-signing/) covers the rollout, how to verify a signature, and the full policy.

Free code signing provided by [SignPath.io](https://about.signpath.io/), certificate by [SignPath Foundation](https://signpath.org/).

- Committers and reviewers: [AquilaXk](https://github.com/AquilaXk)
- Approvers: [AquilaXk](https://github.com/AquilaXk)
- Privacy: easyproxy sends one anonymous daily usage summary (a per-day install hash that changes daily, version, release channel, platform, install channel, provider kind, coarse model family, active minutes and request, token and error counts; never prompts, model outputs, keys, accounts, hostnames or paths) to telemetry.easyproxy.me, and only after the person installing or operating it has seen the notice in the dashboard or an interactive CLI prompt and has not declined. It can be turned off in that notice, in the Windows installer ("Send anonymous usage statistics", checked by default), in Proxy details, or with epx telemetry disable, EPX_TELEMETRY=0 or DO_NOT_TRACK=1. Only project-wide aggregates of this anonymous data are public. A separate public leaderboard profile is off unless you connect one yourself (dashboard Home or epx telemetry profile connect); it shares only a chosen handle, display name and colour and your daily request, token and model-family totals, never your anonymous telemetry ID, and disconnecting deletes it. Everything else goes only to the providers and services you configure. See the [telemetry guide](https://easyproxy.me/guides/telemetry/).

## Disclaimer

easyproxy is an independent, community-maintained project and is **not affiliated with or endorsed by OpenAI, Anthropic, or any other provider**.

Some providers, notably Anthropic (Claude), may suspend or restrict accounts that route API traffic through third-party proxies. **Use at your own risk (UAYOR).** Before connecting a provider, review its Terms of Service to confirm that proxy-based access is permitted. The easyproxy maintainers are not responsible for any account actions taken by upstream providers.

## License

EasyProxy is licensed under the [MIT License](./LICENSE). Third-party components retain their respective licenses; see [`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md).

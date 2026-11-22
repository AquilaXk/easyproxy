import { EXPORT_CLIENT_IDS } from "../clients/client-ids";
import { resolveHelpPath } from "./help-catalog";
import type { Capability } from "./capabilities";
import { MODELS_CONTEXT_DETAILS, MODELS_CONTEXT_USAGE } from "./help-models-context";
import { renderRootHelp } from "./help-navigation";
import { formatHelpRecovery } from "./help-recovery";
import { packageVersion as readPackageVersion } from "../lib/package-version";

/**
 * Version of the `epx` bundle this process is running from.
 *
 * Exported so `status`/`doctor` can compare it against the version the live proxy reports,
 * which is how a stale `epx` earlier on PATH becomes visible (#2701). Returns `"unknown"`
 * rather than throwing; callers must treat that as "cannot compare", not as a mismatch.
 */
export function packageVersion(): string {
  return readPackageVersion();
}

export function printVersion(): void {
  console.log(`easyproxy ${packageVersion()}`);
}

export function printUsage(): void {
  console.log(renderRootHelp());
}

export function printFullUsage(): void {
  console.log(`easyproxy (epx) — Universal provider proxy for Codex

Usage:
  epx setup                   Interactive setup (alias: init)
  epx start [--port <port>] [--socks5 [host:port] | --socks5-off]
                              Start the proxy; SOCKS5 defaults to 127.0.0.1:10808
  epx stop [--json]           Stop the proxy AND restore native Codex (plain codex works again)
  epx restore                 Restore native Codex without stopping (alias: eject)
  epx restore back            Re-point codex at the running proxy (undo restore)
  epx restore --remove-codex-provider-table
                              Also drop [model_providers.easyproxy] that a paginated restore kept
  epx recover-history --legacy-openai --yes
                               Force all user-message easyproxy rows to OpenAI (legacy recovery)
  epx recover-history --epx-compaction <thread-id> --yes
                               Back up and make one epx1-compacted thread replayable by native Codex
  epx uninstall               Remove service/shim/config and restore native Codex (alias: remove)
  epx service [sub]           Run as a background service (default: install if absent, otherwise repair)
  epx codex-shim <sub>        Auto-start proxy when \`codex\` launches (install|status|uninstall|remove)
  epx tray <sub>              Windows status tray (install|start|stop|status|uninstall)
  epx ensure                  Ensure the proxy is running and Codex config/cache are current
  epx connect <url>           Connect this machine to a remote EasyProxy hub (credential via stdin)
  epx remote-workspace <sub>  Pair/run an EPX-only remote execution computer
  epx disconnect              Restore local state and clear the hub connection
  epx sync [--local-only] [--json] [--restart-codex]  Sync models and linked Children
                              --expect-link <id> | --expect-hub-key <id>: only from that Home/hub key (exit 5 otherwise)
                              --child <id>: only those Children; --restart-children[=app-server | =codex --yes]: restart their Codex
  epx sync-cache [--restart-codex]
                              Refresh Codex's model cache from the active catalog
  epx catalog pull <https-url> Install a validated remote catalog and refresh the Codex cache
  epx status                  Check proxy server status (on a hub: one block with its ports and token source)
  epx doctor                  Diagnose environment/network issues (WSL, proxy, ChatGPT reachability)
  epx doctor --reclaim-response-temps
                              Reclaim abandoned response-state temp files (works without a running proxy)
  epx doctor --recover-zero-byte-coordinator --yes
                              Back up a proven zero-byte Codex coordinator after stopping the proxy
  epx debug <scope>           provider/usage/injection/claude on|off|status|reset
  epx login <provider>        OAuth or API-key provider login (epx login codex for Codex/ChatGPT)
  epx logout <provider>       Remove a stored OAuth login
  epx gui [pair [--desktop] --origin <browser-origin> [--json]]
                              Open the dashboard, pair a remote GUI, or authorize local Desktop changes (--desktop)
  epx hub invite [--json]     Print a ready-to-run \`epx connect\` line for one more machine
                              (hub only; see \`epx help hub\` for the one-port topology)
  epx link <sub>              Machine links over SSH (port|issue|revoke|status|check)
  epx update [--tag <tag>]    Update easyproxy (keeps preview installs on @preview)
  epx restart                  Stop and restart the proxy
  epx v2 <sub>                multi_agent_v2 surface (status|on|off|mode|keep-native-v1|threads|mode-hint)
  epx health [--json]          Check proxy health (exit 0=healthy, 1=not)
  epx capabilities [--json] [--contracts]  List capabilities and contracts
  epx ready [--json] [--wait [--timeout <s>]]  Check post-sync readiness (exit 0 only when ready)
  epx resolve [--json]        Config home, effective port, and liveness (JSON for shells)
  epx provider <sub>          Providers, connectivity, quota, and selected models
  epx account <sub>           Accounts, login/reauth, key pools, and quota controls
  epx models <sub>            Live/custom models, visibility, context, and shadow calls
  epx alias <sub>             Short names for providers and models (list, set, rm, defaults)
  epx combo <sub>             Combo routing strategies and failover
  epx agent <sub>             Subagents, injection, effort caps, and sidecars
  epx message <sub>           Codex queued messages, explicit SSH peers and foreground ownership
  epx effort [sub]            Inspect and configure reasoning effort caps and defaults
  epx fallback <sub>          Turn model or provider fallback off per scope; per-device local fallback
  epx observe <sub>           Logs, usage, storage, memory, and debug data
  epx inspect <sub>           Effective config, catalog, analytics, pacing, client-config
  epx route <sub>             Routing features (to, combo, policy)
  epx logs [filters]          Alias of epx observe logs
  epx usage [--range <today|1d|7d|30d|all>] [--provider <name>] [--model <id>] [--top <1-1000>]
                              Token and estimated-cost report (alias of epx observe usage)
  epx storage <sub>           Storage report, cleanup, trash, and the cleanup policy
  epx memory [--json]         Alias of epx observe memory
  epx api-key <sub>           Alias of epx access key
  epx access <sub>            External API keys and endpoint information
  epx api <sub>               Protocol paths: vocabulary, request-path preview, and policy
  epx export --client <id>    Print a client config wired to the running proxy (${EXPORT_CLIENT_IDS.length} clients)
  epx integration client <sub> Enable, disable, inspect or roll back a client integration
  epx grok <sub>              Grok Build model selection and apply
  epx system <sub>            Runtime settings, startup, sync, EasyProxy updates, and Codex CLI inspection
  epx config [sub]            Validated configuration show/get/set/import/export
  epx advisor <status|on|off|set|consent>  Advisor sidecar settings and context-sharing consent
  epx companion <show|set|reset>  Menu-bar and widget companion usage settings
  epx telemetry <sub>         Anonymous usage telemetry status, preview, enable, and disable
  epx lab <sub>               Inspect Lab evidence and control local automation
  epx codex-provider <sub>    Confirm custom Codex provider routing: status|allow|revoke
  epx chatgpt <sub>          Experimental app-server shim: launch|restore|status (macOS)
  epx claude [args...]        Launch Claude Code wired to the proxy (model discovery on)
  epx claude desktop [sub]    Manage and apply Claude Desktop's four-family profile
  epx codex [args...]         Launch Codex through the proxy's routing (pass-through when disabled)
  epx opencode [args...]      Launch opencode wired to the proxy (runtime provider config)
  epx mcode [args...]         Launch MiniMax Code through its managed provider
  epx mmx text <sub> [args]   Launch MiniMax CLI text through the proxy
  epx zcode [sub]             Connect ZCode to the proxy (managed provider)
  epx commandcode [sub]       Connect Command Code CLI to the proxy (managed provider)
  epx cmd [sub]               Alias of epx commandcode
  epx help [command]          Show help
  epx --version | -v          Print version

Examples:
  epx init                    Set up provider and inject into Codex
  epx start                   Start on default port (10100)
  epx start --port 8080       Start on custom port
  epx start --socks5          Outbound via SOCKS5 at 127.0.0.1:10808 (saved)
  epx start --socks5-off      Clear a saved SOCKS5 outbound proxy
  epx help service            Show service command help
  epx help hub                Explain the hub topology, token file, and invites
  epx sync                    Sync available models to Codex`);
}

export function hasHelpFlag(values: string[]): boolean {
  return values.some(value => value === "--help" || value === "-h" || value === "help");
}

function printCapabilityDetails(capability: Capability, write: (text: string) => void, shown: readonly string[] = []): void {
  if (capability.flags.length) {
    write("\nDeclared flags:");
    for (const flag of capability.flags) {
      write(`  ${flag.name}${flag.value && flag.value !== "boolean" ? ` <${flag.value}>` : ""}${flag.required ? " (required)" : ""}  ${flag.summary}`);
    }
  }
  const details = capability.details?.filter(detail => !shown.includes(detail));
  if (details?.length) write(`\n${details.join("\n")}`);
}

export function printSubcommandUsage(
  name: string | undefined,
  path?: readonly string[],
  options: { fallbackToParent?: boolean; write?: (text: string) => void } = {},
): void {
  const write = options.write ?? console.log;
  const result = resolveHelpPath(path ?? (name ? [name] : []));
  if (result.kind === "unavailable") {
    // Appended flags may follow runtime operands. An explicit `help <path>`
    // requests that exact detail instead, so only the CLI head enables fallback.
    if (options.fallbackToParent && result.parent) {
      printSubcommandUsage(result.parent[0], result.parent, { write });
      return;
    }
    console.error(formatHelpRecovery(result.path));
    process.exit(1);
  }
  if (result.kind === "entry") {
    write(`Usage: ${result.entry.usage}\n\n${result.entry.summary}`);
    if (result.entry.details?.length) write(`\n${result.entry.details.join("\n")}`);
    if (result.capability) printCapabilityDetails(result.capability, write, result.entry.details);
    if (result.children.length) {
      write("\nDeclared commands (incomplete):");
      for (const child of result.children) write(`  epx help ${child.command.join(" ")}  ${child.summary}`);
    }
    if (result.canonicalName === "models") write("\nContext cap help: epx help models context");
    if (result.entry.name !== result.canonicalName) write(`\nCanonical help: epx help ${result.canonicalName}`);
    return;
  }
  if (result.kind === "models-context") {
    write(`Usage:\n${MODELS_CONTEXT_USAGE}\n\n${MODELS_CONTEXT_DETAILS.join("\n")}`);
  } else if (result.kind === "capability") {
    const { capability } = result;
    const heading = capability.usage !== undefined ? `Usage: ${capability.usage}` : `Command: epx ${result.path.join(" ")}`;
    write(`${heading}\n\n${capability.summary}`);
    printCapabilityDetails(capability, write);
    if (result.children.length) {
      write("\nDeclared commands (incomplete):");
      for (const child of result.children) write(`  epx help ${child.command.join(" ")}  ${child.summary}`);
    }
    if (capability.usage === undefined) {
      write("\nCapability metadata is incomplete; this is not the full operand grammar.");
    }
  } else {
    write(`Command group: epx ${result.path.join(" ")}\n\nDeclared commands (incomplete):`);
    for (const child of result.children) write(`  epx ${child.command.join(" ")}  ${child.summary}`);
  }
  write(`\nParent help: epx help ${result.path.slice(0, -1).join(" ")}`);
}

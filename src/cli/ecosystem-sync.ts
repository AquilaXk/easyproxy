import {
  ECOSYSTEM_CLI_IDS,
  ECOSYSTEM_SYNC_KINDS,
  EcosystemSyncError,
  applyEcosystemSync,
  getEcosystemSyncStatus,
  previewEcosystemSync,
  restoreEcosystemSync,
  type EcosystemCliId,
  type EcosystemSyncKind,
} from "../ecosystem/cli-sync";
import { findLiveProxy } from "../server/proxy-liveness";
import {
  CliUsageError,
  csv,
  printData,
  rejectArgs,
  runCliAction,
  runtimeRequest,
  takeFlag,
  takeOption,
  terminalSafeText,
  type RuntimeApiDeps,
} from "./runtime-api";

export const ECOSYSTEM_SYNC_USAGE = `Usage:
  epx integration sync [status] [--json]
  epx integration sync preview --source <claude|codex|gemini|opencode> --targets <csv> [--kinds <mcp,skills>] [--overwrite] [--json]
  epx integration sync apply --source <claude|codex|gemini|opencode> --targets <csv> [--kinds <mcp,skills>] [--overwrite] --yes [--json]
  epx integration sync restore [--batch <id>] [--force] --yes [--json]`;

function parseCliList(raw: string | undefined, flag: string): EcosystemCliId[] {
  const values = csv(raw) ?? [];
  if (!values.length) {
    throw new CliUsageError(`${flag} requires at least one CLI (${ECOSYSTEM_CLI_IDS.join(", ")})`, ECOSYSTEM_SYNC_USAGE);
  }
  for (const item of values) {
    if (!(ECOSYSTEM_CLI_IDS as readonly string[]).includes(item)) {
      throw new CliUsageError(`invalid CLI "${item}" in ${flag}; expected one of ${ECOSYSTEM_CLI_IDS.join(", ")}`, ECOSYSTEM_SYNC_USAGE);
    }
  }
  return values as EcosystemCliId[];
}

function parseKindsList(raw: string | undefined): EcosystemSyncKind[] | undefined {
  if (raw === undefined) return undefined;
  const values = csv(raw) ?? [];
  if (!values.length) {
    throw new CliUsageError(`--kinds requires mcp and/or skills`, ECOSYSTEM_SYNC_USAGE);
  }
  for (const item of values) {
    if (!(ECOSYSTEM_SYNC_KINDS as readonly string[]).includes(item)) {
      throw new CliUsageError(`invalid kind "${item}" in --kinds; expected mcp or skills`, ECOSYSTEM_SYNC_USAGE);
    }
  }
  return values as EcosystemSyncKind[];
}

function parseSource(raw: string | undefined): EcosystemCliId {
  if (!raw || !(ECOSYSTEM_CLI_IDS as readonly string[]).includes(raw)) {
    throw new CliUsageError(`--source must be one of ${ECOSYSTEM_CLI_IDS.join(", ")}`, ECOSYSTEM_SYNC_USAGE);
  }
  return raw as EcosystemCliId;
}

async function shouldUseRemoteManagement(deps: RuntimeApiDeps): Promise<boolean> {
  if (deps.baseUrl) return true;
  const live = await (deps.findLiveProxy ?? findLiveProxy)();
  return Boolean(live && live.role !== "client");
}

function mapLocalSyncError(error: unknown): never {
  if (error instanceof EcosystemSyncError) {
    throw new CliUsageError(error.message);
  }
  throw error;
}

export async function handleEcosystemSyncCommand(argv: string[], deps: RuntimeApiDeps = {}): Promise<number> {
  return runCliAction(async () => {
    const args = [...argv];
    const wantsJson = takeFlag(args, "--json");
    const first = args[0]?.toLowerCase();
    const action = !first || first.startsWith("-") ? "status" : (args.shift() ?? "status").toLowerCase();

    if (action === "status" || action === "show") {
      rejectArgs(args, ECOSYSTEM_SYNC_USAGE);
      const data = (await shouldUseRemoteManagement(deps))
        ? await runtimeRequest("/api/ecosystem/sync", {}, deps)
        : getEcosystemSyncStatus();
      const clis = (data as { clis: Record<string, { installed: boolean; mcpCount: number; skillCount: number }> }).clis;
      const lines = ECOSYSTEM_CLI_IDS.map(id => {
        const entry = clis[id];
        return `${id}: ${entry?.installed ? "installed" : "absent"} (${entry?.mcpCount ?? 0} mcp, ${entry?.skillCount ?? 0} skills)`;
      });
      printData(data, wantsJson, lines);
      return;
    }

    if (action === "preview" || action === "apply") {
      const source = parseSource(takeOption(args, "--source"));
      const targets = parseCliList(takeOption(args, "--targets"), "--targets");
      const kinds = parseKindsList(takeOption(args, "--kinds"));
      const overwrite = takeFlag(args, "--overwrite");
      const yes = takeFlag(args, "--yes");
      rejectArgs(args, ECOSYSTEM_SYNC_USAGE);

      if (action === "preview" && yes) {
        throw new CliUsageError("--yes is only accepted with apply or restore", ECOSYSTEM_SYNC_USAGE);
      }
      if (action === "apply" && !yes) {
        throw new CliUsageError("epx integration sync apply requires --yes", ECOSYSTEM_SYNC_USAGE);
      }

      const payload = {
        source,
        targets,
        ...(kinds ? { kinds } : {}),
        ...(overwrite ? { overwrite: true } : {}),
      };

      const data = (await shouldUseRemoteManagement(deps))
        ? await runtimeRequest(`/api/ecosystem/sync/${action}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          }, deps)
        : action === "preview"
          ? (() => { try { return previewEcosystemSync(payload); } catch (e) { mapLocalSyncError(e); } })()
          : await (async () => { try { return await applyEcosystemSync(payload); } catch (e) { mapLocalSyncError(e); } })();

      if (action === "preview") {
        const p = data as { source: string; targets: string[]; sourceMcpCount: number; sourceSkillCount: number };
        printData(data, wantsJson, [
          `Preview sync from ${terminalSafeText(p.source)} (${p.sourceMcpCount} mcp, ${p.sourceSkillCount} skills) -> ${p.targets.map(t => terminalSafeText(t)).join(", ")}`,
        ]);
      } else {
        const a = data as { batchId: string; appliedMcpCount: number; appliedSkillCount: number; conflictCount: number };
        printData(data, wantsJson, [
          `Applied batch ${terminalSafeText(a.batchId)}: ${a.appliedMcpCount} mcp, ${a.appliedSkillCount} skills synced (${a.conflictCount} conflicts skipped).`,
        ]);
      }
      return;
    }

    if (action === "restore") {
      const batchId = takeOption(args, "--batch");
      const force = takeFlag(args, "--force");
      const yes = takeFlag(args, "--yes");
      rejectArgs(args, ECOSYSTEM_SYNC_USAGE);
      if (!yes) {
        throw new CliUsageError("epx integration sync restore requires --yes", ECOSYSTEM_SYNC_USAGE);
      }
      const payload = {
        ...(batchId ? { batchId } : {}),
        ...(force ? { force: true } : {}),
      };
      const data = (await shouldUseRemoteManagement(deps))
        ? await runtimeRequest("/api/ecosystem/sync/restore", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          }, deps)
        : await (async () => { try { return await restoreEcosystemSync(payload); } catch (e) { mapLocalSyncError(e); } })();
      const r = data as { restoredBatchId: string; restoredFiles: string[]; removedFiles: string[] };
      printData(data, wantsJson, [
        `Restored batch ${terminalSafeText(r.restoredBatchId)}: ${r.restoredFiles.length} restored, ${r.removedFiles.length} removed.`,
      ]);
      return;
    }

    throw new CliUsageError(`unknown ecosystem sync action "${action}"`, ECOSYSTEM_SYNC_USAGE);
  });
}

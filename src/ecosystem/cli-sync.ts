import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, rmdirSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { atomicWriteFileNoFollowUnclaimed } from "../config/atomic-write";
import { expandUserPath, getConfigDir, withConfigDirHardeningSettled } from "../config/paths";
import {
  assertNotRealClaudeConfigUnderTest,
  assertNotRealCodexHomeUnderTest,
  assertNotRealHomeUnderTest,
  isTestHomeGuardArmed,
} from "../lib/test-home-guard";
import {
  ecosystemSyncDir,
  readEcosystemJournal,
  readEcosystemSnapshotBytes,
  removeBatchSnapshotDir,
  summarizeBatches,
  withEcosystemJournalLock,
  writeEcosystemJournal,
  writeEcosystemSnapshotFile,
  type EcosystemBatchSummary,
  type EcosystemFileChangeRecord,
  type EcosystemSyncBatch,
} from "./cli-sync-journal";
import {
  ECOSYSTEM_CLI_IDS,
  ECOSYSTEM_SYNC_KINDS,
  EcosystemSyncError,
  MAX_ECOSYSTEM_CONFIG_BYTES,
  buildMergedMcpConfigBytes,
  readBoundedNonSymlinkFile,
  readCliMcpConfig,
  redactMcpServer,
  sha256Hex,
  type EcosystemCliId,
  type EcosystemSyncKind,
  type NormalizedMcpServer,
  type RedactedMcpServer,
  type UnsupportedMcpEntry,
} from "./cli-sync-mcp";
import {
  MAX_ECOSYSTEM_SKILL_BYTES,
  readCliSkills,
  redactSkillSummary,
  type DiscoveredSkill,
  type RedactedSkillSummary,
} from "./cli-sync-skills";

export { EcosystemSyncError, ECOSYSTEM_CLI_IDS, ECOSYSTEM_SYNC_KINDS };
export type { EcosystemCliId, EcosystemSyncKind, RedactedMcpServer, RedactedSkillSummary, EcosystemBatchSummary };

const REAL_HOME_AT_LOAD = resolve(process.env.EPX_REAL_HOME?.trim() || homedir());

export interface EcosystemSyncPathOptions {
  env?: NodeJS.ProcessEnv;
  home?: string;
  codexHome?: string;
  configDir?: string;
}

export interface EcosystemSyncTestHooks {
  homeDir?: string;
  codexHome?: string;
  configDir?: string;
  env?: NodeJS.ProcessEnv;
  onBeforeWriteTarget?: (target: EcosystemCliId, kind: EcosystemSyncKind, targetPath: string) => void;
}

let syncTestHooks: EcosystemSyncTestHooks | null = null;

export function setEcosystemSyncTestHooks(hooks: EcosystemSyncTestHooks | null): void {
  syncTestHooks = hooks;
}

export interface ResolvedCliPaths {
  cli: EcosystemCliId;
  configDir: string;
  mcpPath: string;
  skillsDir: string;
}

export interface ResolvedEcosystemPaths {
  syncHome: string;
  easyproxyConfigDir: string;
  clis: Record<EcosystemCliId, ResolvedCliPaths>;
}

function sameOrInsidePath(parent: string, candidate: string): boolean {
  const normParent = resolve(parent);
  const normCandidate = resolve(candidate);
  const compareParent = process.platform === "darwin" || process.platform === "win32"
    ? normParent.toLowerCase()
    : normParent;
  const compareCandidate = process.platform === "darwin" || process.platform === "win32"
    ? normCandidate.toLowerCase()
    : normCandidate;
  const rel = relative(compareParent, compareCandidate);
  return rel === "" || (!rel.startsWith("..") && rel !== ".." && !isAbsolute(rel));
}

function assertNotUnisolatedRealHomeTarget(path: string, label: string): void {
  if (!isTestHomeGuardArmed()) return;
  const protectedRoots = [
    join(REAL_HOME_AT_LOAD, ".claude"),
    join(REAL_HOME_AT_LOAD, ".claude.json"),
    join(REAL_HOME_AT_LOAD, ".codex"),
    join(REAL_HOME_AT_LOAD, ".gemini"),
    join(REAL_HOME_AT_LOAD, ".config", "opencode"),
  ];
  for (const root of protectedRoots) {
    if (sameOrInsidePath(root, path)) {
      throw new Error(
        `refusing to write ${label} inside real home (${root}) from a test process; set EPX_CLI_SYNC_HOME or pass isolated EcosystemSyncPathOptions.`,
      );
    }
  }
  if (resolve(dirname(path)) === REAL_HOME_AT_LOAD && path.endsWith(".claude.json")) {
    throw new Error(
      `refusing to write real home ${path} from a test process; set EPX_CLI_SYNC_HOME or pass isolated EcosystemSyncPathOptions.`,
    );
  }
}

export function assertSafeEcosystemWriteTargets(paths: ResolvedEcosystemPaths): void {
  assertNotRealHomeUnderTest(paths.easyproxyConfigDir);
  if (!isTestHomeGuardArmed()) return;
  assertNotRealClaudeConfigUnderTest(
    paths.clis.claude.configDir,
    paths.clis.claude.skillsDir,
  );
  assertNotRealCodexHomeUnderTest(paths.clis.codex.configDir);
  for (const cliId of ECOSYSTEM_CLI_IDS) {
    const cli = paths.clis[cliId];
    assertNotUnisolatedRealHomeTarget(cli.configDir, `${cliId} dir`);
    assertNotUnisolatedRealHomeTarget(cli.mcpPath, `${cliId} MCP config`);
    assertNotUnisolatedRealHomeTarget(cli.skillsDir, `${cliId} skills dir`);
  }
}

function expandPathWithEnv(rawPath: string, env: NodeJS.ProcessEnv): string {
  const home = env.HOME?.trim() || env.USERPROFILE?.trim() || homedir();
  if (rawPath === "~") return home;
  if (rawPath.startsWith("~/") || rawPath.startsWith("~\\")) return join(home, rawPath.slice(2));
  return expandUserPath(rawPath);
}

export function resolveEcosystemPaths(options?: EcosystemSyncPathOptions): ResolvedEcosystemPaths {
  const env = options?.env ?? syncTestHooks?.env ?? process.env;
  const explicitHomeOverride = options?.home ?? syncTestHooks?.homeDir;
  const envSyncHome = env.EPX_CLI_SYNC_HOME?.trim();
  const useSyncHomeDirectly = Boolean(explicitHomeOverride || envSyncHome);

  const rawSyncHome = explicitHomeOverride
    ?? (envSyncHome || undefined)
    ?? env.HOME?.trim()
    ?? homedir();
  const syncHome = resolve(expandPathWithEnv(rawSyncHome, env));

  const rawEasyproxyDir = options?.configDir ?? syncTestHooks?.configDir;
  const easyproxyConfigDir = rawEasyproxyDir
    ? resolve(expandPathWithEnv(rawEasyproxyDir, env))
    : getConfigDir();

  const claudeDir = !useSyncHomeDirectly && env.CLAUDE_CONFIG_DIR?.trim()
    ? resolve(expandPathWithEnv(env.CLAUDE_CONFIG_DIR.trim(), env))
    : join(syncHome, ".claude");

  const codexDir = options?.codexHome
    ? resolve(expandPathWithEnv(options.codexHome, env))
    : syncTestHooks?.codexHome
      ? resolve(expandPathWithEnv(syncTestHooks.codexHome, env))
      : !useSyncHomeDirectly && env.CODEX_HOME?.trim()
        ? resolve(expandPathWithEnv(env.CODEX_HOME.trim(), env))
        : join(syncHome, ".codex");

  const geminiDir = !useSyncHomeDirectly && env.GEMINI_CLI_HOME?.trim()
    ? resolve(expandPathWithEnv(env.GEMINI_CLI_HOME.trim(), env))
    : join(syncHome, ".gemini");

  const opencodeDir = !useSyncHomeDirectly && env.XDG_CONFIG_HOME?.trim()
    ? join(resolve(expandPathWithEnv(env.XDG_CONFIG_HOME.trim(), env)), "opencode")
    : join(syncHome, ".config", "opencode");

  return {
    syncHome,
    easyproxyConfigDir,
    clis: {
      claude: {
        cli: "claude",
        configDir: claudeDir,
        mcpPath: join(syncHome, ".claude.json"),
        skillsDir: join(claudeDir, "skills"),
      },
      codex: {
        cli: "codex",
        configDir: codexDir,
        mcpPath: join(codexDir, "config.toml"),
        skillsDir: join(codexDir, "skills"),
      },
      gemini: {
        cli: "gemini",
        configDir: geminiDir,
        mcpPath: join(geminiDir, "settings.json"),
        skillsDir: join(geminiDir, "skills"),
      },
      opencode: {
        cli: "opencode",
        configDir: opencodeDir,
        mcpPath: join(opencodeDir, "opencode.json"),
        skillsDir: join(opencodeDir, "skills"),
      },
    },
  };
}

export interface CliEcosystemStatus {
  cli: EcosystemCliId;
  installed: boolean;
  mcpPath: string;
  skillsDir: string;
  mcpCount: number;
  skillCount: number;
  mcp: RedactedMcpServer[];
  skills: RedactedSkillSummary[];
  unsupportedMcp: UnsupportedMcpEntry[];
  warnings: string[];
}

export interface EcosystemSyncStatusResponse {
  schemaVersion: 1;
  clis: Record<EcosystemCliId, CliEcosystemStatus>;
  batches: EcosystemBatchSummary[];
}

export function isEcosystemCliId(value: unknown): value is EcosystemCliId {
  return typeof value === "string" && (ECOSYSTEM_CLI_IDS as readonly string[]).includes(value);
}

export interface EcosystemSyncPlanRequest {
  source: EcosystemCliId;
  targets: EcosystemCliId[];
  kinds?: EcosystemSyncKind[];
  overwrite?: boolean;
}

export type SyncItemAction = "create" | "update" | "unchanged" | "conflict";

export interface PlannedMcpChange {
  name: string;
  action: SyncItemAction;
  transport: "stdio" | "http" | "sse";
  digest: string;
  targetDigest?: string;
}

export interface PlannedSkillChange {
  slug: string;
  action: SyncItemAction;
  digest: string;
  bytes: number;
  targetDigest?: string;
}

export interface TargetSyncPlan {
  target: EcosystemCliId;
  installed: boolean;
  mcp: PlannedMcpChange[];
  skills: PlannedSkillChange[];
  unsupportedSourceMcp: UnsupportedMcpEntry[];
  warnings: string[];
}

export interface EcosystemSyncPreviewResponse {
  schemaVersion: 1;
  source: EcosystemCliId;
  targets: EcosystemCliId[];
  kinds: EcosystemSyncKind[];
  overwrite: boolean;
  sourceMcpCount: number;
  sourceSkillCount: number;
  unsupportedSourceMcp: UnsupportedMcpEntry[];
  plans: Partial<Record<EcosystemCliId, TargetSyncPlan>>;
}

export interface EcosystemSyncApplyResponse {
  schemaVersion: 1;
  batchId: string;
  createdAt: number;
  source: EcosystemCliId;
  targets: EcosystemCliId[];
  kinds: EcosystemSyncKind[];
  overwrite: boolean;
  appliedMcpCount: number;
  appliedSkillCount: number;
  conflictCount: number;
  skippedCount: number;
  filesWritten: string[];
  plans: Partial<Record<EcosystemCliId, TargetSyncPlan>>;
}

export interface EcosystemSyncRestoreRequest {
  batchId?: string;
  force?: boolean;
}

export interface EcosystemSyncRestoreResponse {
  schemaVersion: 1;
  restoredBatchId: string;
  restoredFiles: string[];
  removedFiles: string[];
}

function validatePlanInput(request: EcosystemSyncPlanRequest): {
  source: EcosystemCliId;
  targets: EcosystemCliId[];
  kinds: EcosystemSyncKind[];
  overwrite: boolean;
} {
  if (!isEcosystemCliId(request.source)) {
    throw new EcosystemSyncError(`Invalid source CLI: ${String(request.source)}`, 400, "invalid_ecosystem_source");
  }
  if (!Array.isArray(request.targets) || request.targets.length === 0) {
    throw new EcosystemSyncError("At least one target CLI is required", 400, "invalid_ecosystem_targets");
  }
  const seenTargets = new Set<EcosystemCliId>();
  const targets: EcosystemCliId[] = [];
  for (const target of request.targets) {
    if (!isEcosystemCliId(target)) {
      throw new EcosystemSyncError(`Invalid target CLI: ${String(target)}`, 400, "invalid_ecosystem_targets");
    }
    if (target === request.source) {
      throw new EcosystemSyncError(`Target CLI cannot match source CLI (${target})`, 400, "invalid_ecosystem_targets");
    }
    if (!seenTargets.has(target)) {
      seenTargets.add(target);
      targets.push(target);
    }
  }
  const requestedKinds = request.kinds && request.kinds.length > 0 ? request.kinds : [...ECOSYSTEM_SYNC_KINDS];
  const seenKinds = new Set<EcosystemSyncKind>();
  const kinds: EcosystemSyncKind[] = [];
  for (const kind of requestedKinds) {
    if (kind !== "mcp" && kind !== "skills") {
      throw new EcosystemSyncError(`Invalid sync kind: ${String(kind)}`, 400, "invalid_ecosystem_kinds");
    }
    if (!seenKinds.has(kind)) {
      seenKinds.add(kind);
      kinds.push(kind);
    }
  }
  return {
    source: request.source,
    targets,
    kinds,
    overwrite: request.overwrite === true,
  };
}

function cliInstalled(paths: ResolvedCliPaths): boolean {
  if (paths.cli === "claude") {
    return existsSync(paths.configDir) || existsSync(paths.mcpPath);
  }
  return existsSync(paths.configDir) || existsSync(paths.mcpPath);
}

export function getEcosystemSyncStatus(pathOptions?: EcosystemSyncPathOptions): EcosystemSyncStatusResponse {
  const paths = resolveEcosystemPaths(pathOptions);
  const clis = {} as Record<EcosystemCliId, CliEcosystemStatus>;

  for (const cli of ECOSYSTEM_CLI_IDS) {
    const cliPaths = paths.clis[cli];
    const warnings: string[] = [];
    let mcpList: RedactedMcpServer[] = [];
    let unsupportedMcp: UnsupportedMcpEntry[] = [];
    try {
      const mcp = readCliMcpConfig(cli, cliPaths.mcpPath, { strict: false });
      mcpList = [...mcp.servers.values()].map(redactMcpServer);
      unsupportedMcp = mcp.unsupported;
      warnings.push(...mcp.warnings);
    } catch (error) {
      if (error instanceof EcosystemSyncError && error.code === "ecosystem_limit_exceeded") {
        throw error;
      }
      warnings.push((error as Error).message);
    }

    let skillList: RedactedSkillSummary[] = [];
    try {
      const skillsRes = readCliSkills(cliPaths.skillsDir, { strict: false, includeContent: false });
      skillList = [...skillsRes.skills.values()].map(redactSkillSummary);
      warnings.push(...skillsRes.warnings);
    } catch (error) {
      if (error instanceof EcosystemSyncError && error.code === "ecosystem_limit_exceeded") {
        throw error;
      }
      warnings.push((error as Error).message);
    }

    clis[cli] = {
      cli,
      installed: cliInstalled(cliPaths),
      mcpPath: cliPaths.mcpPath,
      skillsDir: cliPaths.skillsDir,
      mcpCount: mcpList.length,
      skillCount: skillList.length,
      mcp: mcpList,
      skills: skillList,
      unsupportedMcp,
      warnings,
    };
  }

  let batches: EcosystemBatchSummary[] = [];
  try {
    batches = summarizeBatches(readEcosystemJournal(paths.easyproxyConfigDir));
  } catch {
    batches = [];
  }

  return {
    schemaVersion: 1,
    clis,
    batches,
  };
}

interface ComputedPlanState {
  paths: ResolvedEcosystemPaths;
  source: EcosystemCliId;
  targets: EcosystemCliId[];
  kinds: EcosystemSyncKind[];
  overwrite: boolean;
  sourceMcp: ReturnType<typeof readCliMcpConfig>;
  sourceSkills: Map<string, DiscoveredSkill>;
  targetStates: Map<EcosystemCliId, {
    plan: TargetSyncPlan;
    targetMcp: ReturnType<typeof readCliMcpConfig>;
    mcpUpdates: NormalizedMcpServer[];
    skillUpdates: DiscoveredSkill[];
  }>;
  preview: EcosystemSyncPreviewResponse;
}

function buildPlan(request: EcosystemSyncPlanRequest, pathOptions?: EcosystemSyncPathOptions, includeSkillContent = false): ComputedPlanState {
  const { source, targets, kinds, overwrite } = validatePlanInput(request);
  const paths = resolveEcosystemPaths(pathOptions);
  const srcPaths = paths.clis[source];

  const syncMcp = kinds.includes("mcp");
  const syncSkills = kinds.includes("skills");

  const sourceMcp = syncMcp
    ? readCliMcpConfig(source, srcPaths.mcpPath, { strict: true })
    : { exists: false, format: "json" as const, document: {}, servers: new Map<string, NormalizedMcpServer>(), unsupported: [], warnings: [] };

  const sourceSkills = syncSkills
    ? readCliSkills(srcPaths.skillsDir, { strict: true, includeContent: includeSkillContent }).skills
    : new Map<string, DiscoveredSkill>();

  const targetStates = new Map<EcosystemCliId, {
    plan: TargetSyncPlan;
    targetMcp: ReturnType<typeof readCliMcpConfig>;
    mcpUpdates: NormalizedMcpServer[];
    skillUpdates: DiscoveredSkill[];
  }>();
  const plans: Partial<Record<EcosystemCliId, TargetSyncPlan>> = {};

  for (const target of targets) {
    const tgtPaths = paths.clis[target];
    const targetMcp = syncMcp
      ? readCliMcpConfig(target, tgtPaths.mcpPath, { strict: true })
      : { exists: false, format: "json" as const, document: {}, servers: new Map<string, NormalizedMcpServer>(), unsupported: [], warnings: [] };
    const targetSkills = syncSkills
      ? readCliSkills(tgtPaths.skillsDir, { strict: true, includeContent: false }).skills
      : new Map<string, DiscoveredSkill>();

    const plannedMcp: PlannedMcpChange[] = [];
    const mcpUpdates: NormalizedMcpServer[] = [];
    if (syncMcp) {
      for (const server of sourceMcp.servers.values()) {
        const existing = targetMcp.servers.get(server.name);
        if (!existing) {
          plannedMcp.push({ name: server.name, action: "create", transport: server.transport, digest: server.digest });
          mcpUpdates.push(server);
        } else if (existing.digest === server.digest) {
          plannedMcp.push({ name: server.name, action: "unchanged", transport: server.transport, digest: server.digest, targetDigest: existing.digest });
        } else if (overwrite) {
          plannedMcp.push({ name: server.name, action: "update", transport: server.transport, digest: server.digest, targetDigest: existing.digest });
          mcpUpdates.push(server);
        } else {
          plannedMcp.push({ name: server.name, action: "conflict", transport: server.transport, digest: server.digest, targetDigest: existing.digest });
        }
      }
    }

    const plannedSkills: PlannedSkillChange[] = [];
    const skillUpdates: DiscoveredSkill[] = [];
    if (syncSkills) {
      for (const skill of sourceSkills.values()) {
        const existing = targetSkills.get(skill.slug);
        if (!existing) {
          plannedSkills.push({ slug: skill.slug, action: "create", digest: skill.digest, bytes: skill.bytes });
          skillUpdates.push(skill);
        } else if (existing.digest === skill.digest) {
          plannedSkills.push({ slug: skill.slug, action: "unchanged", digest: skill.digest, bytes: skill.bytes, targetDigest: existing.digest });
        } else if (overwrite) {
          plannedSkills.push({ slug: skill.slug, action: "update", digest: skill.digest, bytes: skill.bytes, targetDigest: existing.digest });
          skillUpdates.push(skill);
        } else {
          plannedSkills.push({ slug: skill.slug, action: "conflict", digest: skill.digest, bytes: skill.bytes, targetDigest: existing.digest });
        }
      }
    }

    const plan: TargetSyncPlan = {
      target,
      installed: cliInstalled(tgtPaths),
      mcp: plannedMcp,
      skills: plannedSkills,
      unsupportedSourceMcp: [...sourceMcp.unsupported],
      warnings: [...targetMcp.warnings],
    };
    plans[target] = plan;
    targetStates.set(target, { plan, targetMcp, mcpUpdates, skillUpdates });
  }

  return {
    paths,
    source,
    targets,
    kinds,
    overwrite,
    sourceMcp,
    sourceSkills,
    targetStates,
    preview: {
      schemaVersion: 1,
      source,
      targets,
      kinds,
      overwrite,
      sourceMcpCount: sourceMcp.servers.size,
      sourceSkillCount: sourceSkills.size,
      unsupportedSourceMcp: [...sourceMcp.unsupported],
      plans,
    },
  };
}

export function previewEcosystemSync(
  request: EcosystemSyncPlanRequest,
  pathOptions?: EcosystemSyncPathOptions,
): EcosystemSyncPreviewResponse {
  return buildPlan(request, pathOptions, false).preview;
}

function ensureDirectoriesTrackingCreated(targetDir: string): string[] {
  const created: string[] = [];
  const resolved = resolve(targetDir);
  const missing: string[] = [];
  let cursor = resolved;
  while (true) {
    try {
      const stat = lstatSync(cursor);
      if (stat.isSymbolicLink()) {
        throw new EcosystemSyncError(`Refusing symlink directory component: ${cursor}`, 400, "ecosystem_symlink_refused");
      }
      if (!stat.isDirectory()) {
        throw new EcosystemSyncError(`Expected directory at ${cursor}`, 400, "ecosystem_invalid_file");
      }
      break;
    } catch (error) {
      if ((error as { code?: string })?.code !== "ENOENT") {
        if (error instanceof EcosystemSyncError) throw error;
        throw new EcosystemSyncError(`Cannot prepare directory ${cursor}`, 400, "ecosystem_io_error");
      }
      missing.push(cursor);
      const parent = dirname(cursor);
      if (parent === cursor) break;
      cursor = parent;
    }
  }
  for (let i = missing.length - 1; i >= 0; i--) {
    const dir = missing[i]!;
    mkdirSync(dir);
    created.push(dir);
  }
  return created;
}

function pruneCreatedDirs(createdDirs: string[]): void {
  // Safely prune only directories this batch itself created, deepest first, only when empty.
  for (let d = createdDirs.length - 1; d >= 0; d--) {
    const dir = createdDirs[d]!;
    try {
      const stat = lstatSync(dir);
      if (!stat.isSymbolicLink() && stat.isDirectory()) {
        rmdirSync(dir);
      }
    } catch {
      /* ignore non-empty or missing directories */
    }
  }
}

async function revertEcosystemFileChange(
  easyproxyConfigDir: string,
  file: EcosystemFileChangeRecord,
): Promise<"restored" | "removed" | "absent"> {
  assertNotUnisolatedRealHomeTarget(file.targetPath, "restore target");
  if (file.existed) {
    if (!file.snapshotFile) {
      throw new EcosystemSyncError(`Journal entry missing snapshot reference for ${file.targetPath}`, 500, "ecosystem_journal_corrupt");
    }
    const priorBytes = readEcosystemSnapshotBytes(easyproxyConfigDir, file.snapshotFile);
    await withConfigDirHardeningSettled(easyproxyConfigDir, () => {
      mkdirSync(dirname(file.targetPath), { recursive: true });
      atomicWriteFileNoFollowUnclaimed(file.targetPath, priorBytes.toString("utf8"));
    });
    return "restored";
  }

  let removed = false;
  try {
    const stat = lstatSync(file.targetPath);
    if (stat.isSymbolicLink()) {
      throw new EcosystemSyncError(`Refusing to unlink symlink during restore: ${file.targetPath}`, 400, "ecosystem_symlink_refused");
    }
    unlinkSync(file.targetPath);
    removed = true;
  } catch (error) {
    if ((error as { code?: string })?.code !== "ENOENT") {
      throw error;
    }
  }
  pruneCreatedDirs(file.createdDirs);
  return removed ? "removed" : "absent";
}

export async function applyEcosystemSync(
  request: EcosystemSyncPlanRequest,
  pathOptions?: EcosystemSyncPathOptions,
): Promise<EcosystemSyncApplyResponse> {
  const initialPaths = resolveEcosystemPaths(pathOptions);
  assertSafeEcosystemWriteTargets(initialPaths);

  return withEcosystemJournalLock(initialPaths.easyproxyConfigDir, async () => {
    const computed = buildPlan(request, pathOptions, true);
    assertSafeEcosystemWriteTargets(computed.paths);

    const batchId = `sync-${Date.now()}-${randomUUID().slice(0, 8)}`;
    const files: EcosystemFileChangeRecord[] = [];
    const filesWritten: string[] = [];
    let pendingCreatedDirs: string[] = [];
    let appliedMcpCount = 0;
    let appliedSkillCount = 0;
    let conflictCount = 0;
    let skippedCount = 0;

    let snapIndex = 0;

    try {
      for (const [target, state] of computed.targetStates) {
        const tgtPaths = computed.paths.clis[target];
        for (const item of state.plan.mcp) {
          if (item.action === "conflict") {
            conflictCount++;
            skippedCount++;
          } else if (item.action === "unchanged") {
            skippedCount++;
          } else {
            appliedMcpCount++;
          }
        }
        for (const item of state.plan.skills) {
          if (item.action === "conflict") {
            conflictCount++;
            skippedCount++;
          } else if (item.action === "unchanged") {
            skippedCount++;
          } else {
            appliedSkillCount++;
          }
        }

        if (state.mcpUpdates.length > 0) {
          const preBytes = readBoundedNonSymlinkFile(tgtPaths.mcpPath, MAX_ECOSYSTEM_CONFIG_BYTES, `${target} MCP config`);
          pendingCreatedDirs = ensureDirectoriesTrackingCreated(dirname(tgtPaths.mcpPath));
          const nextText = buildMergedMcpConfigBytes(target, state.targetMcp, state.mcpUpdates);
          syncTestHooks?.onBeforeWriteTarget?.(target, "mcp", tgtPaths.mcpPath);
          let snapshotFile: string | undefined;
          await withConfigDirHardeningSettled(computed.paths.easyproxyConfigDir, () => {
            if (preBytes !== null) {
              snapshotFile = writeEcosystemSnapshotFile(computed.paths.easyproxyConfigDir, batchId, snapIndex++, preBytes);
            }
            atomicWriteFileNoFollowUnclaimed(tgtPaths.mcpPath, nextText);
          });
          files.push({
            targetCli: target,
            kind: "mcp",
            targetPath: tgtPaths.mcpPath,
            existed: preBytes !== null,
            ...(snapshotFile ? { snapshotFile } : {}),
            preDigest: preBytes ? sha256Hex(preBytes) : null,
            postDigest: sha256Hex(Buffer.from(nextText, "utf8")),
            createdDirs: pendingCreatedDirs,
          });
          pendingCreatedDirs = [];
          filesWritten.push(tgtPaths.mcpPath);
        }

        for (const skill of state.skillUpdates) {
          if (!skill.content) continue;
          const targetSkillDir = join(tgtPaths.skillsDir, skill.slug);
          const targetSkillMd = join(targetSkillDir, "SKILL.md");
          const preBytes = readBoundedNonSymlinkFile(targetSkillMd, MAX_ECOSYSTEM_SKILL_BYTES, `${target} skill ${skill.slug}`);
          pendingCreatedDirs = ensureDirectoriesTrackingCreated(targetSkillDir);
          const contentText = skill.content.toString("utf8");
          syncTestHooks?.onBeforeWriteTarget?.(target, "skills", targetSkillMd);
          let snapshotFile: string | undefined;
          await withConfigDirHardeningSettled(computed.paths.easyproxyConfigDir, () => {
            if (preBytes !== null) {
              snapshotFile = writeEcosystemSnapshotFile(computed.paths.easyproxyConfigDir, batchId, snapIndex++, preBytes);
            }
            atomicWriteFileNoFollowUnclaimed(targetSkillMd, contentText);
          });
          files.push({
            targetCli: target,
            kind: "skills",
            targetPath: targetSkillMd,
            existed: preBytes !== null,
            ...(snapshotFile ? { snapshotFile } : {}),
            preDigest: preBytes ? sha256Hex(preBytes) : null,
            postDigest: sha256Hex(Buffer.from(contentText, "utf8")),
            createdDirs: pendingCreatedDirs,
          });
          pendingCreatedDirs = [];
          filesWritten.push(targetSkillMd);
        }
      }

      if (files.length > 0) {
        await withConfigDirHardeningSettled(computed.paths.easyproxyConfigDir, () => {
          const journal = readEcosystemJournal(computed.paths.easyproxyConfigDir);
          const batch: EcosystemSyncBatch = {
            batchId,
            createdAt: Date.now(),
            source: computed.source,
            targets: computed.targets,
            kinds: computed.kinds,
            overwrite: computed.overwrite,
            files,
          };
          writeEcosystemJournal(computed.paths.easyproxyConfigDir, {
            schemaVersion: 1,
            batches: [batch, ...journal.batches],
          });
        });
      }
    } catch (error) {
      pruneCreatedDirs(pendingCreatedDirs);
      for (let i = files.length - 1; i >= 0; i--) {
        try {
          await revertEcosystemFileChange(computed.paths.easyproxyConfigDir, files[i]!);
        } catch {
          /* best-effort reverse compensation; preserve earlier rollbacks and rethrow original error */
        }
      }
      try {
        removeBatchSnapshotDir(computed.paths.easyproxyConfigDir, batchId);
      } catch {
        /* ignore snapshot cleanup errors on aborted batch */
      }
      throw error;
    }

    return {
      schemaVersion: 1,
      batchId,
      createdAt: Date.now(),
      source: computed.source,
      targets: computed.targets,
      kinds: computed.kinds,
      overwrite: computed.overwrite,
      appliedMcpCount,
      appliedSkillCount,
      conflictCount,
      skippedCount,
      filesWritten,
      plans: computed.preview.plans,
    };
  });
}

export async function restoreEcosystemSync(
  request: EcosystemSyncRestoreRequest = {},
  pathOptions?: EcosystemSyncPathOptions,
): Promise<EcosystemSyncRestoreResponse> {
  const paths = resolveEcosystemPaths(pathOptions);
  assertSafeEcosystemWriteTargets(paths);

  return withEcosystemJournalLock(paths.easyproxyConfigDir, async () => {
    const journal = readEcosystemJournal(paths.easyproxyConfigDir);
    const batch = request.batchId
      ? journal.batches.find(b => b.batchId === request.batchId)
      : journal.batches[0];
    if (!batch) {
      throw new EcosystemSyncError(
        request.batchId ? `Sync batch not found: ${request.batchId}` : "No ecosystem sync batch found to restore",
        404,
        "ecosystem_sync_batch_not_found",
      );
    }

    const force = request.force === true;
    const drifted: string[] = [];

    for (const file of batch.files) {
      const maxLimit = file.kind === "skills" ? MAX_ECOSYSTEM_SKILL_BYTES : MAX_ECOSYSTEM_CONFIG_BYTES;
      const currentBytes = readBoundedNonSymlinkFile(file.targetPath, maxLimit, `restore target ${file.targetPath}`);
      if (!force) {
        if (!currentBytes) {
          drifted.push(file.targetPath);
        } else if (sha256Hex(currentBytes) !== file.postDigest) {
          drifted.push(file.targetPath);
        }
      }
      if (file.existed && !file.snapshotFile) {
        throw new EcosystemSyncError(`Journal entry missing snapshot reference for ${file.targetPath}`, 500, "ecosystem_journal_corrupt");
      }
      if (file.existed && file.snapshotFile) {
        readEcosystemSnapshotBytes(paths.easyproxyConfigDir, file.snapshotFile);
      }
    }

    if (drifted.length > 0 && !force) {
      throw new EcosystemSyncError(
        `Restore conflict: target files were modified since sync (${drifted.join(", ")}); pass force=true to override.`,
        409,
        "ecosystem_sync_conflict",
      );
    }

    const restoredFiles: string[] = [];
    const removedFiles: string[] = [];

    for (let i = batch.files.length - 1; i >= 0; i--) {
      const file = batch.files[i]!;
      const outcome = await revertEcosystemFileChange(paths.easyproxyConfigDir, file);
      if (outcome === "restored") restoredFiles.push(file.targetPath);
      else if (outcome === "removed") removedFiles.push(file.targetPath);
    }

    await withConfigDirHardeningSettled(paths.easyproxyConfigDir, () => {
      const remaining = journal.batches.filter(b => b.batchId !== batch.batchId);
      writeEcosystemJournal(paths.easyproxyConfigDir, {
        schemaVersion: 1,
        batches: remaining,
      });
      removeBatchSnapshotDir(paths.easyproxyConfigDir, batch.batchId);
    });

    return {
      schemaVersion: 1,
      restoredBatchId: batch.batchId,
      restoredFiles,
      removedFiles,
    };
  });
}

export function clearEcosystemSyncJournalDirForTests(configDir: string): void {
  assertNotRealHomeUnderTest(configDir);
  const dir = ecosystemSyncDir(configDir);
  if (existsSync(dir)) {
    throw new EcosystemSyncError("Use temp tree cleanup directly", 400, "ecosystem_io_error");
  }
}

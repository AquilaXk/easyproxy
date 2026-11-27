import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import type { OutboundPayloadHygieneStats } from "../server/outbound-payload-hygiene";
import {
  CliUsageError,
  printData,
  rejectArgs,
  runCliAction,
  runtimeRequest,
  summaryLines,
  takeBooleanOption,
  takeFlag,
  takeIntegerOption,
  takeOption,
  type RuntimeApiDeps,
} from "./runtime-api";

export const GUARDRAILS_FILE_MAX_BYTES = 262_144;
export const GUARDRAILS_TEXT_MAX_CHARS = 65_536;
export const GUARDRAILS_DRY_RUN_BODY_MAX_BYTES = 524_288;

const SECRET_MODES = new Set(["off", "redact", "block"] as const);
const COMPRESSION_BOUNDS = {
  minChars: { min: 512, max: 500_000 },
  headChars: { min: 0, max: 100_000 },
  tailChars: { min: 0, max: 100_000 },
  dedupMinChars: { min: 128, max: 500_000 },
} as const;

type SecretGuardMode = "off" | "redact" | "block";
type PromptCacheTtl = "auto" | "5m" | "1h";

const CACHE_TTLS: ReadonlySet<PromptCacheTtl> = new Set(["auto", "5m", "1h"]);

export const GUARDRAILS_USAGE = `Usage:
  epx guardrails [status] [--json]
  epx guardrails set [--secret-mode <off|redact|block>] [--compress <on|off>] [--min-chars <512..500000>] [--head-chars <0..100000>] [--tail-chars <0..100000>] [--strip-ansi <on|off>] [--compact-json <on|off>] [--fold-lines <on|off>] [--dedup <on|off>] [--dedup-min-chars <128..500000>] [--cache-inject <on|off>] [--cache-ttl <auto|5m|1h>] [--strip-timestamps <on|off>] [--reset-secret-guard] [--reset-compression] [--reset-prompt-cache] [--json]
  epx guardrails dry-run (--text <str> | --file <path>) [--secret-mode <off|redact|block>] [--compress <on|off>] [--min-chars <512..500000>] [--head-chars <0..100000>] [--tail-chars <0..100000>] [--strip-ansi <on|off>] [--compact-json <on|off>] [--fold-lines <on|off>] [--dedup <on|off>] [--dedup-min-chars <128..500000>] [--cache-inject <on|off>] [--cache-ttl <auto|5m|1h>] [--strip-timestamps <on|off>] [--duplicate-pass] [--json]`;

interface GuardrailsViewResponse {
  outboundSecretGuard?: { mode: string };
  toolOutputCompression?: {
    enabled: boolean;
    minChars: number;
    headChars: number;
    tailChars: number;
    stripAnsi: boolean;
    compactJson?: boolean;
    foldRepetitiveLines?: boolean;
    deduplicateIdentical?: boolean;
    dedupMinChars?: number;
  };
  promptCacheInjection?: {
    enabled: boolean;
    ttl: PromptCacheTtl;
    stripVolatileSystemTimestamps: boolean;
  };
  stats?: OutboundPayloadHygieneStats;
}

interface GuardrailsDryRunResponse {
  blocked?: boolean;
  limitExceeded?: boolean;
  matches?: number;
  redactions?: number;
  findings?: string[];
  compressedItems?: number;
  compactedJsonItems?: number;
  foldedLogItems?: number;
  deduplicatedItems?: number;
  injectedCacheBreakpoints?: number;
  normalizedTimestamps?: number;
  contextInspection?: {
    cache?: {
      wireFormat?: string;
      explicitBreakpoints?: number;
      breakpointCount?: number;
      warnings?: string[];
    };
    usedTokens?: number;
    totalTokens?: number;
  };
  originalChars?: number;
  outputChars?: number;
  savedChars?: number;
  estimatedSavedTokens?: number;
  previewText?: string;
}

interface ParsedGuardrailOverrides {
  secretGuard?: { mode: SecretGuardMode };
  compression?: {
    enabled?: boolean;
    minChars?: number;
    headChars?: number;
    tailChars?: number;
    stripAnsi?: boolean;
    compactJson?: boolean;
    foldRepetitiveLines?: boolean;
    deduplicateIdentical?: boolean;
    dedupMinChars?: number;
  };
  promptCacheInjection?: {
    enabled?: boolean;
    ttl?: PromptCacheTtl;
    stripVolatileSystemTimestamps?: boolean;
  };
}

function takeUniqueOption(args: string[], flag: string): string | undefined {
  const value = takeOption(args, flag);
  if (value !== undefined && args.includes(flag)) {
    throw new CliUsageError(`${flag} was given more than once`, GUARDRAILS_USAGE);
  }
  return value;
}

function takeUniqueBool(args: string[], flag: string): boolean | undefined {
  let value: boolean | undefined;
  try {
    value = takeBooleanOption(args, flag);
  } catch (error) {
    if (error instanceof CliUsageError) throw new CliUsageError(error.message, GUARDRAILS_USAGE);
    throw error;
  }
  if (value !== undefined && args.includes(flag)) {
    throw new CliUsageError(`${flag} was given more than once`, GUARDRAILS_USAGE);
  }
  return value;
}

function takeUniqueInt(
  args: string[],
  flag: string,
  bounds: { min: number; max: number },
): number | undefined {
  let value: number | undefined;
  try {
    value = takeIntegerOption(args, flag, bounds);
  } catch (error) {
    if (error instanceof CliUsageError) throw new CliUsageError(error.message, GUARDRAILS_USAGE);
    throw error;
  }
  if (value !== undefined && args.includes(flag)) {
    throw new CliUsageError(`${flag} was given more than once`, GUARDRAILS_USAGE);
  }
  return value;
}

function parseGuardrailOverrides(args: string[]): ParsedGuardrailOverrides {
  const modeRaw = takeUniqueOption(args, "--secret-mode");
  let secretGuard: { mode: SecretGuardMode } | undefined;
  if (modeRaw !== undefined) {
    if (!SECRET_MODES.has(modeRaw as SecretGuardMode)) {
      throw new CliUsageError("--secret-mode must be off, redact, or block", GUARDRAILS_USAGE);
    }
    secretGuard = { mode: modeRaw as SecretGuardMode };
  }

  const enabled = takeUniqueBool(args, "--compress");
  const minChars = takeUniqueInt(args, "--min-chars", COMPRESSION_BOUNDS.minChars);
  const headChars = takeUniqueInt(args, "--head-chars", COMPRESSION_BOUNDS.headChars);
  const tailChars = takeUniqueInt(args, "--tail-chars", COMPRESSION_BOUNDS.tailChars);
  const stripAnsi = takeUniqueBool(args, "--strip-ansi");
  const compactJson = takeUniqueBool(args, "--compact-json");
  const foldRepetitiveLines = takeUniqueBool(args, "--fold-lines");
  const deduplicateIdentical = takeUniqueBool(args, "--dedup");
  const dedupMinChars = takeUniqueInt(args, "--dedup-min-chars", COMPRESSION_BOUNDS.dedupMinChars);

  const compression: NonNullable<ParsedGuardrailOverrides["compression"]> = {};
  if (enabled !== undefined) compression.enabled = enabled;
  if (minChars !== undefined) compression.minChars = minChars;
  if (headChars !== undefined) compression.headChars = headChars;
  if (tailChars !== undefined) compression.tailChars = tailChars;
  if (stripAnsi !== undefined) compression.stripAnsi = stripAnsi;
  if (compactJson !== undefined) compression.compactJson = compactJson;
  if (foldRepetitiveLines !== undefined) compression.foldRepetitiveLines = foldRepetitiveLines;
  if (deduplicateIdentical !== undefined) compression.deduplicateIdentical = deduplicateIdentical;
  if (dedupMinChars !== undefined) compression.dedupMinChars = dedupMinChars;

  const cacheEnabled = takeUniqueBool(args, "--cache-inject");
  const cacheTtlRaw = takeUniqueOption(args, "--cache-ttl");
  let cacheTtl: PromptCacheTtl | undefined;
  if (cacheTtlRaw !== undefined) {
    if (!CACHE_TTLS.has(cacheTtlRaw as PromptCacheTtl)) {
      throw new CliUsageError("--cache-ttl must be auto, 5m, or 1h", GUARDRAILS_USAGE);
    }
    cacheTtl = cacheTtlRaw as PromptCacheTtl;
  }
  const stripVolatileSystemTimestamps = takeUniqueBool(args, "--strip-timestamps");

  const promptCacheInjection: NonNullable<ParsedGuardrailOverrides["promptCacheInjection"]> = {};
  if (cacheEnabled !== undefined) promptCacheInjection.enabled = cacheEnabled;
  if (cacheTtl !== undefined) promptCacheInjection.ttl = cacheTtl;
  if (stripVolatileSystemTimestamps !== undefined) {
    promptCacheInjection.stripVolatileSystemTimestamps = stripVolatileSystemTimestamps;
  }

  return {
    ...(secretGuard ? { secretGuard } : {}),
    ...(Object.keys(compression).length > 0 ? { compression } : {}),
    ...(Object.keys(promptCacheInjection).length > 0 ? { promptCacheInjection } : {}),
  };
}

function readDryRunFile(filePath: string): string {
  if (!filePath.trim()) {
    throw new CliUsageError("--file requires a non-empty file path", GUARDRAILS_USAGE);
  }
  let initialStat: ReturnType<typeof lstatSync>;
  try {
    initialStat = lstatSync(filePath);
  } catch {
    throw new CliUsageError("Unable to inspect --file input", GUARDRAILS_USAGE);
  }
  if (initialStat.isSymbolicLink()) {
    throw new CliUsageError("--file must not be a symlink", GUARDRAILS_USAGE);
  }
  if (!initialStat.isFile()) {
    throw new CliUsageError("--file must be a regular file", GUARDRAILS_USAGE);
  }
  if (initialStat.size > GUARDRAILS_FILE_MAX_BYTES) {
    throw new CliUsageError(`--file exceeds ${GUARDRAILS_FILE_MAX_BYTES} bytes`, GUARDRAILS_USAGE);
  }

  const openFlags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
  let fd: number;
  try {
    fd = openSync(filePath, openFlags);
  } catch {
    throw new CliUsageError("Unable to open regular --file input", GUARDRAILS_USAGE);
  }

  try {
    const fdStat = fstatSync(fd);
    if (!fdStat.isFile() || fdStat.dev !== initialStat.dev || fdStat.ino !== initialStat.ino) {
      throw new CliUsageError("--file changed or is not a regular file", GUARDRAILS_USAGE);
    }
    if (fdStat.size > GUARDRAILS_FILE_MAX_BYTES) {
      throw new CliUsageError(`--file exceeds ${GUARDRAILS_FILE_MAX_BYTES} bytes`, GUARDRAILS_USAGE);
    }

    const buffer = Buffer.allocUnsafe(GUARDRAILS_FILE_MAX_BYTES + 1);
    let totalBytes = 0;
    while (totalBytes <= GUARDRAILS_FILE_MAX_BYTES) {
      const n = readSync(fd, buffer, totalBytes, buffer.length - totalBytes, null);
      if (n === 0) break;
      totalBytes += n;
    }
    if (totalBytes > GUARDRAILS_FILE_MAX_BYTES) {
      throw new CliUsageError(`--file exceeds ${GUARDRAILS_FILE_MAX_BYTES} bytes`, GUARDRAILS_USAGE);
    }
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, totalBytes));
    } catch {
      throw new CliUsageError("--file must contain valid UTF-8 text", GUARDRAILS_USAGE);
    }
  } finally {
    closeSync(fd);
  }
}

function formatGuardrailsViewLines(data: GuardrailsViewResponse): string[] {
  if (!data.outboundSecretGuard || !data.toolOutputCompression) return summaryLines(data);
  const comp = data.toolOutputCompression;
  const compExtras = [
    ...(comp.compactJson !== undefined ? [`compactJson=${comp.compactJson}`] : []),
    ...(comp.foldRepetitiveLines !== undefined ? [`foldRepetitiveLines=${comp.foldRepetitiveLines}`] : []),
    ...(comp.deduplicateIdentical !== undefined ? [`deduplicateIdentical=${comp.deduplicateIdentical}`] : []),
    ...(comp.dedupMinChars !== undefined ? [`dedupMinChars=${comp.dedupMinChars}`] : []),
  ];
  const lines = [
    `Outbound secret guard: mode=${data.outboundSecretGuard.mode}`,
    `Tool output compression: enabled=${comp.enabled} minChars=${comp.minChars} headChars=${comp.headChars} tailChars=${comp.tailChars} stripAnsi=${comp.stripAnsi}${compExtras.length > 0 ? ` ${compExtras.join(" ")}` : ""}`,
  ];
  if (data.promptCacheInjection) {
    const pci = data.promptCacheInjection;
    lines.push(
      `Prompt cache injection: enabled=${pci.enabled} ttl=${pci.ttl} stripVolatileSystemTimestamps=${pci.stripVolatileSystemTimestamps}`,
    );
  }
  if (data.stats) {
    const s = data.stats;
    lines.push(
      `Stats: scannedRequests=${s.scannedRequests} secretDetections=${s.secretDetections} secretBlocks=${s.secretBlocks} compressedToolOutputs=${s.compressedToolOutputs} compactedJsonOutputs=${s.compactedJsonOutputs} foldedLogOutputs=${s.foldedLogOutputs} deduplicatedToolOutputs=${s.deduplicatedToolOutputs} injectedCacheBreakpoints=${s.injectedCacheBreakpoints} normalizedSystemTimestamps=${s.normalizedSystemTimestamps} savedChars=${s.savedChars} estimatedSavedTokens=${s.estimatedSavedTokens}`,
    );
  }
  return lines;
}

function formatDryRunLines(data: GuardrailsDryRunResponse): string[] {
  if (typeof data.blocked !== "boolean") return summaryLines(data);
  const findings = Array.isArray(data.findings) && data.findings.length > 0
    ? data.findings.join(",")
    : "none";
  const compExtras = [
    ...(data.compactedJsonItems !== undefined ? [`compactedJsonItems=${data.compactedJsonItems}`] : []),
    ...(data.foldedLogItems !== undefined ? [`foldedLogItems=${data.foldedLogItems}`] : []),
    ...(data.deduplicatedItems !== undefined ? [`deduplicatedItems=${data.deduplicatedItems}`] : []),
    ...(data.estimatedSavedTokens !== undefined ? [`estimatedSavedTokens=${data.estimatedSavedTokens}`] : []),
  ];
  const lines = [
    `Blocked: ${data.blocked} (limitExceeded=${Boolean(data.limitExceeded)})`,
    `Secret guard: matches=${data.matches ?? 0} redactions=${data.redactions ?? 0} findings=${findings}`,
    `Compression: compressedItems=${data.compressedItems ?? 0} originalChars=${data.originalChars ?? 0} outputChars=${data.outputChars ?? 0} savedChars=${data.savedChars ?? 0}${compExtras.length > 0 ? ` ${compExtras.join(" ")}` : ""}`,
  ];
  if (data.injectedCacheBreakpoints !== undefined || data.normalizedTimestamps !== undefined) {
    lines.push(
      `Prompt cache: injectedBreakpoints=${data.injectedCacheBreakpoints ?? 0} normalizedTimestamps=${data.normalizedTimestamps ?? 0}`,
    );
  }
  if (data.contextInspection) {
    const warnings = data.contextInspection.cache?.warnings;
    lines.push(
      `Context inspection: wireFormat=${data.contextInspection.cache?.wireFormat ?? "unknown"} usedTokens=${data.contextInspection.usedTokens ?? data.contextInspection.totalTokens ?? 0} breakpoints=${data.contextInspection.cache?.explicitBreakpoints ?? data.contextInspection.cache?.breakpointCount ?? 0} warnings=${Array.isArray(warnings) && warnings.length > 0 ? warnings.join(",") : "none"}`,
    );
  }
  if (typeof data.previewText === "string" && data.previewText.length > 0) {
    lines.push(`Preview (${data.previewText.length} chars):`, data.previewText);
  }
  return lines;
}

async function handleStatus(args: string[], deps: RuntimeApiDeps): Promise<void> {
  const wantsJson = takeFlag(args, "--json");
  rejectArgs(args, GUARDRAILS_USAGE);
  const data = await runtimeRequest<GuardrailsViewResponse>(
    "/api/gateway-guardrails",
    { redirect: "error" },
    deps,
  );
  printData(data, wantsJson, formatGuardrailsViewLines(data));
}

async function handleSet(args: string[], deps: RuntimeApiDeps): Promise<void> {
  const wantsJson = takeFlag(args, "--json");
  const resetSecretGuard = takeFlag(args, "--reset-secret-guard");
  const resetCompression = takeFlag(args, "--reset-compression");
  const resetPromptCache = takeFlag(args, "--reset-prompt-cache");
  const overrides = parseGuardrailOverrides(args);
  rejectArgs(args, GUARDRAILS_USAGE);

  if (resetSecretGuard && overrides.secretGuard) {
    throw new CliUsageError("--reset-secret-guard cannot be combined with --secret-mode", GUARDRAILS_USAGE);
  }
  if (resetCompression && overrides.compression) {
    throw new CliUsageError(
      "--reset-compression cannot be combined with compression flags",
      GUARDRAILS_USAGE,
    );
  }
  if (resetPromptCache && overrides.promptCacheInjection) {
    throw new CliUsageError(
      "--reset-prompt-cache cannot be combined with prompt cache flags",
      GUARDRAILS_USAGE,
    );
  }

  const body: Record<string, unknown> = {};
  if (resetSecretGuard) body.outboundSecretGuard = null;
  else if (overrides.secretGuard) body.outboundSecretGuard = overrides.secretGuard;

  if (resetCompression) body.toolOutputCompression = null;
  else if (overrides.compression) body.toolOutputCompression = overrides.compression;

  if (resetPromptCache) body.promptCacheInjection = null;
  else if (overrides.promptCacheInjection) body.promptCacheInjection = overrides.promptCacheInjection;

  if (Object.keys(body).length === 0) {
    throw new CliUsageError(
      "guardrails set requires at least one setting or reset flag",
      GUARDRAILS_USAGE,
    );
  }

  const data = await runtimeRequest<GuardrailsViewResponse>(
    "/api/gateway-guardrails",
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      redirect: "error",
    },
    deps,
  );
  printData(data, wantsJson, formatGuardrailsViewLines(data));
}

async function handleDryRun(args: string[], deps: RuntimeApiDeps): Promise<void> {
  const wantsJson = takeFlag(args, "--json");
  const duplicatePass = takeFlag(args, "--duplicate-pass");
  const textOption = takeUniqueOption(args, "--text");
  const fileOption = takeUniqueOption(args, "--file");
  const overrides = parseGuardrailOverrides(args);
  rejectArgs(args, GUARDRAILS_USAGE);

  if (textOption !== undefined && fileOption !== undefined) {
    throw new CliUsageError("--text and --file cannot be used together", GUARDRAILS_USAGE);
  }
  if (textOption === undefined && fileOption === undefined) {
    throw new CliUsageError("dry-run requires either --text <str> or --file <path>", GUARDRAILS_USAGE);
  }

  const text = textOption !== undefined ? textOption : readDryRunFile(fileOption!);
  if (text.length > GUARDRAILS_TEXT_MAX_CHARS) {
    throw new CliUsageError(
      `dry-run text exceeds maximum length of ${GUARDRAILS_TEXT_MAX_CHARS} characters`,
      GUARDRAILS_USAGE,
    );
  }

  const payload = {
    text,
    ...(duplicatePass ? { duplicatePass: true } : {}),
    ...(overrides.secretGuard ? { outboundSecretGuard: overrides.secretGuard } : {}),
    ...(overrides.compression ? { toolOutputCompression: overrides.compression } : {}),
    ...(overrides.promptCacheInjection ? { promptCacheInjection: overrides.promptCacheInjection } : {}),
  };
  const serialized = JSON.stringify(payload);
  if (Buffer.byteLength(serialized, "utf8") > GUARDRAILS_DRY_RUN_BODY_MAX_BYTES) {
    throw new CliUsageError(
      `dry-run request body exceeds ${GUARDRAILS_DRY_RUN_BODY_MAX_BYTES} bytes`,
      GUARDRAILS_USAGE,
    );
  }

  const data = await runtimeRequest<GuardrailsDryRunResponse>(
    "/api/gateway-guardrails/dry-run",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: serialized,
      redirect: "error",
    },
    deps,
  );
  printData(data, wantsJson, formatDryRunLines(data));
}

export async function handleGuardrailsCommand(
  argv: string[],
  deps: RuntimeApiDeps = {},
): Promise<number> {
  return await runCliAction(async () => {
    const args = [...argv];
    const sub = args.length === 0 || args[0]!.startsWith("-") ? "status" : args.shift()!;
    if (sub === "status") await handleStatus(args, deps);
    else if (sub === "set") await handleSet(args, deps);
    else if (sub === "dry-run") await handleDryRun(args, deps);
    else throw new CliUsageError(`unknown guardrails command ${sub}`, GUARDRAILS_USAGE);
  });
}

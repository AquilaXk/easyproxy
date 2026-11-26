/**
 * Pre-output HTTP 400 recovery and 1-hour capability memo when an OpenAI-operated Responses
 * destination rejects an `input[N]` control item of `type === "configuration_update"`.
 *
 * Indexes are checked against the ACTUAL sent frame (including Codex WebSocket incremental delta
 * frames, where upstream indexes into the delta's `input` slice rather than full history), and
 * simple `reasoning.effort` enum value errors are excluded so they continue flowing into
 * `refusedReasoningEffortDowngrade`.
 */
import { createHash } from "node:crypto";
import { isReasoningEffortRejection } from "../../providers/reasoning-metadata";
import { isPlainObject } from "./internal";

export const CONFIGURATION_UPDATE_CAPABILITY_TTL_MS = 60 * 60 * 1000;
export const MAX_CONFIG_UPDATE_MEMO_ENTRIES = 256;
const MAX_ERROR_BYTES = 16 * 1024;
const MAX_PARAM_CHARS = 256;
const MAX_MESSAGE_SCAN = 4096;

const unsupportedDestinations = new Map<string, number>();

export function destinationHostOfUrl(rawUrl: string | undefined): string | undefined {
  if (!rawUrl) return undefined;
  try {
    return new URL(rawUrl).hostname.toLowerCase() || undefined;
  } catch {
    return undefined;
  }
}

function capabilityMemoKey(destination: string | undefined, modelId: string | undefined): string | undefined {
  const host = destination?.trim().toLowerCase();
  const model = modelId?.trim().toLowerCase();
  if (!host || !model) return undefined;
  return createHash("sha256").update(`${host}\0${model}`).digest("hex").slice(0, 32);
}

function sweepMemo(now: number): void {
  for (const [key, recordedAt] of unsupportedDestinations) {
    if (now - recordedAt > CONFIGURATION_UPDATE_CAPABILITY_TTL_MS) {
      unsupportedDestinations.delete(key);
    }
  }
}

export function isConfigurationUpdateUnsupportedMemoized(
  destination: string | undefined,
  modelId: string | undefined,
  now = Date.now(),
): boolean {
  const key = capabilityMemoKey(destination, modelId);
  if (!key) return false;
  sweepMemo(now);
  const recordedAt = unsupportedDestinations.get(key);
  if (recordedAt === undefined) return false;
  if (now - recordedAt > CONFIGURATION_UPDATE_CAPABILITY_TTL_MS) {
    unsupportedDestinations.delete(key);
    return false;
  }
  return true;
}

export function rememberConfigurationUpdateUnsupported(
  destination: string | undefined,
  modelId: string | undefined,
  now = Date.now(),
): void {
  const key = capabilityMemoKey(destination, modelId);
  if (!key) return;
  sweepMemo(now);
  unsupportedDestinations.delete(key);
  unsupportedDestinations.set(key, now);
  while (unsupportedDestinations.size > MAX_CONFIG_UPDATE_MEMO_ENTRIES) {
    const oldest = unsupportedDestinations.keys().next().value;
    if (oldest === undefined) break;
    unsupportedDestinations.delete(oldest);
  }
}

export function resetConfigurationUpdateCapabilityMemoForTests(): void {
  unsupportedDestinations.clear();
}

const EFFORT_ENUM_PARAM_RE = /(?:^|\.)(?:reasoning(?:\.effort)?|effort)$/i;
const INPUT_PARAM_INDEX_RE = /^input(?:\[(\d{1,6})\]|\.(\d{1,6}))(?:\.([a-zA-Z0-9_.\[\]]+))?$/;
const INPUT_MESSAGE_INDEX_RE = /\binput(?:\[(\d{1,6})\]|\.(\d{1,6}))(?:\.([a-zA-Z0-9_.]+))?/g;
const EFFORT_ENUM_HINT_RE = /\b(?:unsupported(?:_value)?|invalid value)\b[^.\n]{0,120}\b(?:minimal|low|medium|high|xhigh|max|ultra|none)\b/i;

function extractErrorFields(errorText: string): { param?: string; message: string; code?: string } {
  const bounded = errorText.slice(0, MAX_MESSAGE_SCAN);
  try {
    const parsed = JSON.parse(errorText) as unknown;
    if (isPlainObject(parsed)) {
      const errorObj = isPlainObject(parsed.error) ? parsed.error : parsed;
      const param = typeof errorObj.param === "string" && errorObj.param.length <= MAX_PARAM_CHARS
        ? errorObj.param.trim()
        : undefined;
      const message = typeof errorObj.message === "string"
        ? errorObj.message.slice(0, MAX_MESSAGE_SCAN)
        : bounded;
      const code = typeof errorObj.code === "string" ? errorObj.code.trim().toLowerCase() : undefined;
      return { param, message, code };
    }
  } catch {
    // Non-JSON upstream error: inspect bounded raw text directly.
  }
  return { message: bounded };
}

function candidateInputIndices(param: string | undefined, message: string, mentionsConfigUpdate: boolean): number[] {
  const indices: number[] = [];
  if (param) {
    if (EFFORT_ENUM_PARAM_RE.test(param)) return [];
    const match = INPUT_PARAM_INDEX_RE.exec(param);
    if (match) {
      const suffix = match[3];
      if (suffix && (suffix !== "type" || EFFORT_ENUM_PARAM_RE.test(suffix))) return [];
      const idx = Number(match[1] ?? match[2]);
      if (Number.isSafeInteger(idx) && idx >= 0) indices.push(idx);
    }
  }
  INPUT_MESSAGE_INDEX_RE.lastIndex = 0;
  for (let m = INPUT_MESSAGE_INDEX_RE.exec(message); m !== null; m = INPUT_MESSAGE_INDEX_RE.exec(message)) {
    const suffix = m[3];
    if (suffix && !mentionsConfigUpdate && EFFORT_ENUM_PARAM_RE.test(suffix)) continue;
    if (suffix && suffix !== "type" && !suffix.startsWith("type.") && EFFORT_ENUM_PARAM_RE.test(suffix)) continue;
    const idx = Number(m[1] ?? m[2]);
    if (Number.isSafeInteger(idx) && idx >= 0 && !indices.includes(idx)) {
      indices.push(idx);
    }
  }
  return indices;
}

/**
 * Determine whether a pre-output HTTP 400 error specifically rejected an `input[N]` item of
 * `type === "configuration_update"` present in the ACTUAL sent request frame.
 */
export function matchConfigurationUpdate400Rejection(args: {
  status: number;
  nonReplayable: boolean;
  errorText: string;
  sentBodyText: string | undefined;
}): boolean {
  if (args.status !== 400 || args.nonReplayable || !args.sentBodyText || !args.errorText) return false;
  if (Buffer.byteLength(args.errorText, "utf8") > MAX_ERROR_BYTES) return false;

  const { param, message } = extractErrorFields(args.errorText);
  const mentionsConfigUpdate = /\bconfiguration_update\b/i.test(message) || /\bconfiguration_update\b/i.test(param ?? "");
  const targetsType = Boolean(param && /\.type$/i.test(param)) || /\binput(?:\[\d+\]|\.\d+)\.type\b/i.test(message);

  // Simple reasoning-effort enum rejections (e.g. "Unsupported value: 'xhigh'") are handled
  // by `refusedReasoningEffortDowngrade` rather than dropping `configuration_update` history items.
  if (param && EFFORT_ENUM_PARAM_RE.test(param)) return false;
  if (!mentionsConfigUpdate && !targetsType && (isReasoningEffortRejection(args.errorText) || EFFORT_ENUM_HINT_RE.test(message))) {
    return false;
  }

  const indices = candidateInputIndices(param, message, mentionsConfigUpdate);
  if (indices.length === 0) return false;

  let sentBody: unknown;
  try {
    sentBody = JSON.parse(args.sentBodyText);
  } catch {
    return false;
  }
  if (!isPlainObject(sentBody) || !Array.isArray(sentBody.input)) return false;

  return indices.some((idx) => {
    const item = (sentBody.input as unknown[])[idx];
    return isPlainObject(item) && item.type === "configuration_update";
  });
}

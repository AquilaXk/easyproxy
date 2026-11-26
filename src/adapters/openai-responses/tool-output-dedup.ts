import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { isPlainObject } from "./internal";

export const DEDUP_TOOL_OUTPUT_MIN_BYTES = 2048;
export const MAX_DEDUP_HASHES = 1024;

const ERROR_TEXT_PREFIX_RE = /^(?:error:|err[_:]|fatal:|traceback \(most recent call last\):|panic:|command failed\b|exit code:?\s*[1-9]\d*)/i;

function serializeToolOutputPayload(output: unknown): { payload: string; isArray: boolean; isErrorText: boolean } | undefined {
  if (typeof output === "string") {
    const trimmed = output.trimStart();
    let isErrorJson = false;
    if (trimmed.startsWith("{")) {
      try {
        const parsed = JSON.parse(trimmed) as unknown;
        if (isPlainObject(parsed)) {
          if (parsed.is_error === true || parsed.ok === false) isErrorJson = true;
          else if (parsed.error !== undefined && parsed.error !== null && parsed.error !== false) isErrorJson = true;
          else if ((typeof parsed.exitCode === "number" && parsed.exitCode !== 0)
            || (typeof parsed.exit_code === "number" && parsed.exit_code !== 0)) {
            isErrorJson = true;
          }
        }
      } catch {
        // Non-JSON braced text falls through to prefix inspection.
      }
    }
    return {
      payload: output,
      isArray: false,
      isErrorText: isErrorJson || ERROR_TEXT_PREFIX_RE.test(trimmed),
    };
  }
  if (Array.isArray(output)) {
    const firstTextPart = output.find(part => isPlainObject(part) && typeof part.text === "string") as { text: string } | undefined;
    const isErrorFlag = output.some(part => isPlainObject(part) && part.is_error === true);
    const trimmed = firstTextPart ? firstTextPart.text.trimStart() : "";
    return {
      payload: JSON.stringify(output),
      isArray: true,
      isErrorText: isErrorFlag || ERROR_TEXT_PREFIX_RE.test(trimmed),
    };
  }
  if (isPlainObject(output) && output.is_error === true) {
    return { payload: "", isArray: false, isErrorText: true };
  }
  return undefined;
}

export function isToolOutputError(item: Record<string, unknown>, serialized?: { isErrorText: boolean }): boolean {
  if (item.is_error === true) return true;
  if (typeof item.status === "string" && (item.status === "failed" || item.status === "incomplete" || item.status === "error")) {
    return true;
  }
  return serialized?.isErrorText === true;
}

function buildDedupStub(earlierCallId: string, isArray: boolean): string | Array<{ type: "input_text"; text: string }> {
  const stub = `[identical tool output omitted; see earlier call_id=${earlierCallId}]`;
  return isArray ? [{ type: "input_text", text: stub }] : stub;
}

/**
 * Bounded single-pass SHA-256 deduplicator for identical non-error tool outputs >= 2 KiB.
 * Preserves the earliest non-error output and replaces later identical outputs with a
 * reference stub naming the earlier `call_id`.
 */
export class ToolOutputDedupTracker {
  private readonly seenByHash = new Map<string, string>();

  constructor(private readonly allowedTypes: ReadonlySet<string>) {}

  deduplicateItem(item: unknown): { value: unknown; changed: boolean } {
    if (!isPlainObject(item) || typeof item.type !== "string" || !this.allowedTypes.has(item.type)) {
      return { value: item, changed: false };
    }
    const callId = typeof item.call_id === "string" && item.call_id.length > 0 ? item.call_id : undefined;
    if (!callId) return { value: item, changed: false };
    const serialized = serializeToolOutputPayload(item.output);
    if (!serialized || isToolOutputError(item, serialized)) {
      return { value: item, changed: false };
    }
    if (Buffer.byteLength(serialized.payload, "utf8") < DEDUP_TOOL_OUTPUT_MIN_BYTES) {
      return { value: item, changed: false };
    }
    const hash = createHash("sha256").update(serialized.payload, "utf8").digest("hex");
    const earlierCallId = this.seenByHash.get(hash);
    if (earlierCallId !== undefined) {
      if (earlierCallId === callId) return { value: item, changed: false };
      return {
        value: { ...item, output: buildDedupStub(earlierCallId, serialized.isArray) },
        changed: true,
      };
    }
    if (this.seenByHash.size < MAX_DEDUP_HASHES) {
      this.seenByHash.set(hash, callId);
    }
    return { value: item, changed: false };
  }
}

export function deduplicateToolOutputArray(
  items: readonly unknown[],
  allowedTypes: ReadonlySet<string>,
): unknown[] {
  const tracker = new ToolOutputDedupTracker(allowedTypes);
  let changed = false;
  const out = items.map(item => {
    const res = tracker.deduplicateItem(item);
    if (res.changed) changed = true;
    return res.value;
  });
  return changed ? out : [...items];
}

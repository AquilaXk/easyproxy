import { isDeepStrictEqual } from "node:util";
import type { EpxProviderConfig } from "../../types";
import type { ProviderEditorProviderDTO } from "../auth-cors";
import { anthropicInstanceRowShapeMatches } from "../../providers/anthropic-instance-id";
import { assertAnthropicInstanceLoginConfig } from "../../oauth/store-anthropic-instance";

/** Preset publication may create B, but may never take over an existing custom row. */
export function anthropicInstancePublicationError(name: string, next: EpxProviderConfig, existing: EpxProviderConfig | undefined): string | undefined {
  if (name === "anthropic2" && anthropicInstanceRowShapeMatches(name, next)) {
    try { assertAnthropicInstanceLoginConfig({ providers: existing ? { [name]: existing } : {} }, name); }
    catch { return "cannot add Pool 2 over an existing custom provider or unreadable configuration; resolve it first"; }
  }
  return undefined;
}

/** Full form edits omit provenance; preserve only an already owned compatible row. */
export function preserveAnthropicInstanceMarker(name: string, next: EpxProviderConfig, existing: EpxProviderConfig | undefined): void {
  if (name !== "anthropic2" || Object.hasOwn(next, "anthropicOAuthInstance")) return;
  if (anthropicInstanceRowShapeMatches(name, existing) && next.adapter === "anthropic" && next.authMode === "oauth") {
    next.anthropicOAuthInstance = "anthropic2";
  }
}

export function mergeProviderEditorRow(
  persisted: EpxProviderConfig | undefined,
  baseline: ProviderEditorProviderDTO | undefined,
  next: ProviderEditorProviderDTO,
): EpxProviderConfig {
  const merged = structuredClone(persisted ?? {}) as Record<string, unknown>;
  const fields = new Set([...Object.keys(baseline ?? {}), ...Object.keys(next)]);
  for (const field of fields) {
    const baselineHasField = baseline !== undefined && Object.hasOwn(baseline, field);
    const nextHasField = Object.hasOwn(next, field);
    if (
      baselineHasField === nextHasField
      && (!baselineHasField || isDeepStrictEqual(baseline[field], next[field]))
    ) {
      continue;
    }
    if (nextHasField) merged[field] = structuredClone(next[field]);
    else delete merged[field];
  }
  return merged as unknown as EpxProviderConfig;
}

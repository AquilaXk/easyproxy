import type { EpxTelemetryConfig, EpxTelemetryDecision } from "../types/telemetry";

export type TelemetryStatusReason =
  | "env-epx-telemetry"
  | "env-do-not-track"
  | "declined"
  | "accepted"
  | "default-on"
  | "awaiting-notice";

export type TelemetryEnvOverride = "EPX_TELEMETRY" | "DO_NOT_TRACK" | null;

export interface TelemetryConsentStatus {
  effective: boolean;
  reason: TelemetryStatusReason;
  decision: EpxTelemetryDecision | null;
  decidedAt: string | null;
  noticeShownAt: string | null;
  envOverride: TelemetryEnvOverride;
}

const EPX_TELEMETRY_OFF_VALUES = new Set(["0", "false", "off", "no"]);
const DO_NOT_TRACK_ON_VALUES = new Set(["1", "true", "yes"]);

/**
 * Consent lives only in the config's `telemetry` block. A whole config is never read as a block, so
 * a top-level key such as `noticeShownAt` (which `epx config set` can write) is not consent.
 */
function extractTelemetryConfig(
  input: { telemetry?: EpxTelemetryConfig | null } | null | undefined,
): EpxTelemetryConfig | undefined {
  if (!input || typeof input !== "object") return undefined;
  const nested = (input as { telemetry?: unknown }).telemetry;
  return nested && typeof nested === "object" && !Array.isArray(nested)
    ? (nested as EpxTelemetryConfig)
    : undefined;
}

function validIsoString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || Number.isNaN(Date.parse(trimmed))) return null;
  return trimmed;
}

export function isTelemetryEnvOptOut(env: Record<string, string | undefined> = process.env): TelemetryEnvOverride {
  const epx = env.EPX_TELEMETRY?.trim().toLowerCase();
  if (epx !== undefined && EPX_TELEMETRY_OFF_VALUES.has(epx)) {
    return "EPX_TELEMETRY";
  }
  const dnt = env.DO_NOT_TRACK?.trim().toLowerCase();
  if (dnt !== undefined && DO_NOT_TRACK_ON_VALUES.has(dnt)) {
    return "DO_NOT_TRACK";
  }
  return null;
}

export function resolveTelemetryStatus(
  config: { telemetry?: EpxTelemetryConfig | null } | null | undefined,
  env: Record<string, string | undefined> = process.env,
): TelemetryConsentStatus {
  const telemetry = extractTelemetryConfig(config);
  const decision = telemetry?.decision === "accepted" || telemetry?.decision === "declined"
    ? telemetry.decision
    : null;
  const decidedAt = validIsoString(telemetry?.decidedAt);
  const noticeShownAt = validIsoString(telemetry?.noticeShownAt);
  const envOverride = isTelemetryEnvOptOut(env);

  if (envOverride === "EPX_TELEMETRY") {
    return {
      effective: false,
      reason: "env-epx-telemetry",
      decision,
      decidedAt,
      noticeShownAt,
      envOverride,
    };
  }
  if (envOverride === "DO_NOT_TRACK") {
    return {
      effective: false,
      reason: "env-do-not-track",
      decision,
      decidedAt,
      noticeShownAt,
      envOverride,
    };
  }
  if (decision === "declined") {
    return {
      effective: false,
      reason: "declined",
      decision,
      decidedAt,
      noticeShownAt,
      envOverride: null,
    };
  }
  if (decision === "accepted") {
    return {
      effective: true,
      reason: "accepted",
      decision,
      decidedAt,
      noticeShownAt,
      envOverride: null,
    };
  }
  if (noticeShownAt !== null) {
    return {
      effective: true,
      reason: "default-on",
      decision: null,
      decidedAt,
      noticeShownAt,
      envOverride: null,
    };
  }
  return {
    effective: false,
    reason: "awaiting-notice",
    decision: null,
    decidedAt,
    noticeShownAt: null,
    envOverride: null,
  };
}

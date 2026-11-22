import { readCodexAccountRecord } from "../codex/account-store";
import { MAIN_CODEX_ACCOUNT_ID } from "../codex/account-id";
import { getCodexAccountHealthSnapshot, type CodexCooldownSource } from "../codex/routing";
import { maskAccountId } from "../lib/privacy";

export type OAuthAccountHealth =
  | { status: "healthy" }
  | { status: "cooldown"; until: string; reason: "rate_limit" | "quota" }
  | { status: "reauth_required"; reason: OAuthReauthReason }
  | { status: "warning"; reason: "refresh_conflict" | "metadata_mismatch" | "stale_credentials" | "validation_pending" };

/** Why an OAuth account needs reauthentication. */
export type OAuthReauthReason = "unauthorized" | "forbidden" | "refresh_failed" | "verify_account" | "tos_violation";

export type CodexPoolAccountHealth =
  | { status: "healthy" }
  | { status: "cooldown"; until: string; reason: "rate_limit" | "quota" }
  | { status: "reauth_required"; reason: "unauthorized" | "forbidden" | "refresh_failed" }
  | { status: "warning"; reason: "refresh_conflict" | "metadata_mismatch" | "stale_credentials" | "validation_pending" };

export type OAuthHealthLabel =
  | "Healthy"
  | "Rate limited"
  | "Quota limited"
  | "Reauthentication required"
  | "Verification required"
  | "Account suspended"
  | "Refresh failed"
  | "Metadata mismatch"
  | "Credential conflict"
  | "Validation pending";

/** Shared masked-id fallback when `maskAccountId` returns nullish. */
export const MASKED_ACCOUNT_FALLBACK = "account-…????";

export type OAuthHealthEntry = {
  provider: string;
  accountId: string;
  health: OAuthAccountHealth;
  action?: string;
};

export type OAuthAccountHealthFields = {
  health: OAuthAccountHealth;
  healthLabel: OAuthHealthLabel;
  healthSummary: string;
  healthAction?: string;
};

export type OAuthWarningReason = "refresh_conflict" | "metadata_mismatch" | "stale_credentials";

export function projectOAuthAccountHealth(input: {
  needsReauth?: boolean;
  reauthReason?: OAuthReauthReason;
  cooldownUntilMs?: number;
  cooldownReason?: "rate_limit" | "quota";
  warningReason?: OAuthWarningReason;
  now?: number;
}): OAuthAccountHealth {
  const now = input.now ?? Date.now();
  if (input.needsReauth) {
    return { status: "reauth_required", reason: input.reauthReason ?? "refresh_failed" };
  }
  if (
    typeof input.cooldownUntilMs === "number"
    && Number.isFinite(input.cooldownUntilMs)
    && input.cooldownUntilMs > now
  ) {
    return {
      status: "cooldown",
      until: new Date(input.cooldownUntilMs).toISOString(),
      reason: input.cooldownReason ?? "quota",
    };
  }
  if (input.warningReason) {
    return { status: "warning", reason: input.warningReason };
  }
  return { status: "healthy" };
}

/** Codex pool accounts are not a public `epx login` provider; reauth is dashboard-driven. */
export const CODEX_REAUTH_ACTION = "reauthenticate via the dashboard Codex account pool";

export function oauthHealthActionFor(provider: string, health: OAuthAccountHealth): string | undefined {
  if (health.status === "warning" && health.reason === "validation_pending") {
    return "wait for quota recovery, then click Refresh quotas in the dashboard Codex account pool to finish validation";
  }
  if (health.status === "reauth_required") {
    if (provider === "codex") return CODEX_REAUTH_ACTION;
    if (health.reason === "tos_violation") {
      return `the provider suspended this account for a Terms of Service violation; appeal with the provider before running \`epx login ${provider}\` again`;
    }
    if (health.reason === "verify_account") {
      return `verify the account with the provider in a browser, then run \`epx login ${provider}\``;
    }
    return `run \`epx login ${provider}\``;
  }
  if (health.status === "cooldown") {
    return `wait until ${health.until} or start a new session with another eligible account`;
  }
  if (health.status === "warning" && health.reason === "refresh_conflict") {
    return "re-run `epx doctor` after ensuring only one proxy process writes the credential store";
  }
  return undefined;
}

export function oauthHealthLabel(health: OAuthAccountHealth): OAuthHealthLabel {
  switch (health.status) {
    case "healthy":
      return "Healthy";
    case "cooldown":
      return health.reason === "rate_limit" ? "Rate limited" : "Quota limited";
    case "reauth_required":
      if (health.reason === "refresh_failed") return "Refresh failed";
      if (health.reason === "verify_account") return "Verification required";
      if (health.reason === "tos_violation") return "Account suspended";
      return "Reauthentication required";
    case "warning":
      switch (health.reason) {
        case "validation_pending":
          return "Validation pending";
        case "refresh_conflict":
          return "Credential conflict";
        case "metadata_mismatch":
          return "Metadata mismatch";
        case "stale_credentials":
          return "Refresh failed";
      }
  }
}

function displayAccountForHealth(accountId: string): string {
  if (accountId === MAIN_CODEX_ACCOUNT_ID) return "main account";
  return maskAccountId(accountId) ?? MASKED_ACCOUNT_FALLBACK;
}

export function oauthHealthSummary(
  provider: string,
  accountId: string,
  health: OAuthAccountHealth,
  action?: string,
): string {
  const masked = displayAccountForHealth(accountId);
  let summary: string;
  switch (health.status) {
    case "healthy":
      summary = `${provider} ${masked}: healthy`;
      break;
    case "cooldown": {
      const why = health.reason === "rate_limit" ? "rate limited" : "quota limited";
      summary = `${provider} ${masked}: ${why} until ${health.until}. Routing for this account is paused until then.`;
      break;
    }
    case "reauth_required":
      summary = `${provider} ${masked}: reauthentication required (${health.reason.replaceAll("_", " ")}).`;
      break;
    case "warning":
      summary = `${provider} ${masked}: ${health.reason.replaceAll("_", " ")}.`;
      break;
  }
  if (action && health.status !== "healthy") {
    return `${summary} Next: ${action}`;
  }
  return summary;
}

export function oauthAccountHealthFields(
  provider: string,
  accountId: string,
  health: OAuthAccountHealth,
): OAuthAccountHealthFields {
  const action = oauthHealthActionFor(provider, health);
  return {
    health,
    healthLabel: oauthHealthLabel(health),
    healthSummary: oauthHealthSummary(provider, accountId, health, action),
    ...(action ? { healthAction: action } : {}),
  };
}

function cooldownReasonFromSource(
  source: CodexCooldownSource | undefined,
): "rate_limit" | "quota" | undefined {
  if (!source) return undefined;
  return source === "retry-after" ? "rate_limit" : "quota";
}

export function projectCodexAccountHealth(input: {
  accountId: string;
  needsReauth: boolean;
  reauthReason?: "unauthorized" | "forbidden" | "refresh_failed";
  now?: number;
}): CodexPoolAccountHealth {
  const stored = input.accountId !== MAIN_CODEX_ACCOUNT_ID ? readCodexAccountRecord(input.accountId) : null;
  const record = stored?.deletedAt == null ? stored : null;

  const validationAuthFailed = record !== null
    && record.codexValidationPending === true
    && record.lastCodexValidationStatus === "failed"
    && (record.lastCodexValidationError === "http_status:401" || record.lastCodexValidationError === "http_status:403");

  const terminalGrantFailure = record !== null
    && record.lastCodexValidationTerminal === true
    && record.lastCodexValidationStatus === "failed";

  const needsReauth = input.needsReauth || validationAuthFailed || terminalGrantFailure;

  const storedVerificationFailed = validationAuthFailed || terminalGrantFailure;
  const storedFailureReason: "unauthorized" | "forbidden" | undefined = !storedVerificationFailed
    ? undefined
    : record?.lastCodexValidationError === "http_status:403" ? "forbidden"
      : record?.lastCodexValidationError === "http_status:401" ? "unauthorized"
      : undefined;

  if (!needsReauth && record?.codexValidationPending) {
    return { status: "warning", reason: "validation_pending" };
  }
  const now = input.now ?? Date.now();
  const snap = getCodexAccountHealthSnapshot(input.accountId, now);
  return projectOAuthAccountHealth({
    needsReauth,
    reauthReason: needsReauth ? (input.reauthReason ?? storedFailureReason ?? "refresh_failed") : undefined,
    cooldownUntilMs: snap?.cooldownUntil,
    cooldownReason: cooldownReasonFromSource(snap?.cooldownSource),
    now,
  }) as CodexPoolAccountHealth;
}

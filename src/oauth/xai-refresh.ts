import type { OAuthProviderDef } from "./index";
import type { OAuthCredentials } from "./types";
import {
  OAuthMutationBusyError,
  OAuthRefreshIntentIOError,
  createOAuthRefreshIntentLock,
  credentialGeneration,
  getAccountCredentialWithStatus,
  getAccountSet,
  markAccountNeedsReauthIfGeneration,
  mergeAccountCredential,
} from "./store";
import {
  OAuthAccountPausedError,
  OAuthAccountUnusableError,
  OAuthLoginRequiredError,
} from "./oauth-errors";
import { XAI_LOCAL_CLI_DETACH_WARNING, XaiTokenRequestError } from "./xai";
import { AnthropicTokenError } from "./anthropic";
import { KiroTokenRefreshError } from "./kiro";
import { NousTokenError, RefreshIntentIOError } from "./nous";
import { ChatGptTokenError, ChatGptTokenRequestError } from "./chatgpt";
import { mergeAnthropicIdentity } from "./anthropic-identity";
import { mergeOAuthOrganizationName, mergeOAuthPlan } from "./plan";
import {
  detectGrokCliToken,
  hasComparableGrokIdentity,
  isSameGrokIdentity,
  shouldAdoptGrokGeneration,
} from "./local-token-detect";
import { REFRESH_SKEW_MS } from "./refresh-policy";
import { captureConfigGeneration, sweepExpiredOnWrite } from "../lib/state-store-sweeper";

const XAI_PERMANENT_FAILURE_TTL_MS = 30_000;
const permanentRefreshFailures = new Map<string, number>();

export interface XaiRefreshDeps {
  intentLock?: ReturnType<typeof createOAuthRefreshIntentLock>;
  now?: () => number;
  afterPrePersistRead?: () => void | Promise<void>;
  signal?: AbortSignal;
  requireUsableAccount?: boolean;
}

function verdictKey(provider: string, accountId: string, credential: OAuthCredentials): string {
  return `${provider}\0${accountId}\0${credentialGeneration(credential)}`;
}

function hasCachedPermanentFailure(
  provider: string,
  accountId: string,
  credential: OAuthCredentials,
  now: () => number,
): boolean {
  const key = verdictKey(provider, accountId, credential);
  const until = permanentRefreshFailures.get(key);
  if (until === undefined) return false;
  if (until <= now()) {
    permanentRefreshFailures.delete(key);
    return false;
  }
  return true;
}

export function sweepExpiredXaiPermanentFailureVerdicts(now = Date.now()): number {
  let removed = 0;
  for (const [key, until] of permanentRefreshFailures) {
    if (until > now) continue;
    permanentRefreshFailures.delete(key);
    removed += 1;
  }
  return removed;
}

/** Terminal refresh failures (revoked/rotated-away grants) — retrying cannot succeed. */
function isTerminalRefreshError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return msg.includes("invalid_grant")
    || msg.includes("refresh_token_reused")
    || msg.includes("revoked")
    // GitHub Copilot refresh surfaces allowlisted OAuth codes (github-copilot.ts):
    || msg.includes("access_denied")
    || msg.includes("expired_token");
}

export function isTerminalOAuthRefreshFailure(error: unknown): boolean {
  if (error instanceof ChatGptTokenRequestError) return false;
  if (error instanceof XaiTokenRequestError) {
    return ["invalid_grant", "refresh_token_reused", "revoked_token"].includes(error.oauthError ?? "");
  }
  if (error instanceof AnthropicTokenError) {
    return (error.httpStatus === 400 || error.httpStatus === 401)
      && ["invalid_grant", "refresh_token_reused", "revoked", "revoked_token", "refresh_token_revoked"].includes(error.oauthError ?? "");
  }
  if (error instanceof KiroTokenRefreshError) {
    return (error.httpStatus === 400 || error.httpStatus === 401) && error.oauthError !== undefined;
  }
  if (error instanceof NousTokenError) {
    return error.terminal === true
      || ["invalid_grant", "refresh_token_reused", "revoked", "revoked_token", "expired_token"].includes(error.oauthError ?? "");
  }
  // ChatGPT carries the pool classifier's verdict on the error itself: revoked and
  // expired grants are terminal; unknown/transient failures stay retryable.
  if (error instanceof ChatGptTokenError) return error.terminal;
  // Local durable-write/read/cleanup failures are operational, not credential
  // death: the provider credential was never rejected or consumed. Never mark
  // the account needsReauth for broken local persistence infrastructure.
  if (error instanceof RefreshIntentIOError || error instanceof OAuthRefreshIntentIOError) return false;
  return isTerminalRefreshError(error);
}

function authoritativeXaiCredential(
  stored: OAuthCredentials,
  active: boolean,
  now: () => number,
): OAuthCredentials {
  if (stored.source !== "local-cli") return stored;
  const disk = detectGrokCliToken();
  if (!disk) return stored;
  const allowed = isSameGrokIdentity(stored, disk)
    || (active && !hasComparableGrokIdentity(stored, disk));
  return allowed && shouldAdoptGrokGeneration(stored, disk, now(), REFRESH_SKEW_MS)
    ? disk
    : stored;
}

export function mergeRefreshedOAuthCredential(
  fresh: OAuthCredentials,
  previous: OAuthCredentials,
): OAuthCredentials {
  const identity = mergeAnthropicIdentity(fresh, previous, { sameGrant: true });
  return {
    ...fresh,
    ...identity,
    plan: mergeOAuthPlan(fresh, previous),
    organizationName: mergeOAuthOrganizationName({ ...fresh, ...identity }, previous),
    // Shared: a refresh function returns "local-cli" only when the credential it hands back
    // still is the local CLI's (Devin re-reading the CLI file, Meta Muse echoing its durable
    // CLI key). Relabelling that "oauth" would stop the next forced refresh from re-reading it.
    source: fresh.source === "local-cli" ? "local-cli"
      : previous.source === "local-cli" ? "oauth" : fresh.source ?? previous.source ?? "oauth",
    ...(fresh.projectId === undefined && previous.projectId ? { projectId: previous.projectId } : {}),
    ...(fresh.apiBaseUrl === undefined && previous.apiBaseUrl ? { apiBaseUrl: previous.apiBaseUrl } : {}),
    ...(fresh.email === undefined && previous.email ? { email: previous.email } : {}),
    ...(fresh.accountId === undefined && previous.accountId ? { accountId: previous.accountId } : {}),
    ...(fresh.kiro === undefined && previous.kiro ? { kiro: previous.kiro } : {}),
    ...(fresh.m365 === undefined && previous.m365 && fresh.accountId?.toLowerCase() === previous.accountId?.toLowerCase() ? { m365: previous.m365 } : {}),
  };
}

export async function refreshXaiAccountWithLock(
  provider: string,
  accountId: string,
  def: OAuthProviderDef,
  callerCredential: OAuthCredentials,
  deps: XaiRefreshDeps = {},
): Promise<string> {
  const writerGeneration = captureConfigGeneration();
  const now = deps.now ?? Date.now;
  const guard = await (deps.intentLock ?? createOAuthRefreshIntentLock(provider, accountId)).acquire();
  try {
    const row = getAccountCredentialWithStatus(provider, accountId);
    if (!row) throw new OAuthLoginRequiredError(provider);
    if (row.paused) throw new OAuthAccountPausedError();
    if (deps.requireUsableAccount && row.needsReauth) throw new OAuthAccountUnusableError(provider);

    const stored = row.credential;
    const active = getAccountSet(provider)?.activeAccountId === accountId;
    const candidate = authoritativeXaiCredential(stored, active, now);
    if (
      credentialGeneration(candidate) !== credentialGeneration(callerCredential)
      && candidate.expires > now() + REFRESH_SKEW_MS
    ) {
      if (credentialGeneration(candidate) !== credentialGeneration(stored)) {
        const outcome = await mergeAccountCredential(provider, accountId, candidate, {
          expectedGeneration: credentialGeneration(stored),
          afterPrePersistRead: deps.afterPrePersistRead,
        });
        if (outcome.superseded) {
          if (outcome.stored.expires > now() + REFRESH_SKEW_MS) return outcome.stored.access;
          throw new OAuthLoginRequiredError(provider);
        }
      }
      return candidate.access;
    }

    if (hasCachedPermanentFailure(provider, accountId, candidate, now)) {
      throw new OAuthLoginRequiredError(provider);
    }

    const generation = credentialGeneration(candidate);
    try {
      const fresh = mergeRefreshedOAuthCredential(
        await def.refresh(candidate.refresh, deps.signal),
        candidate,
      );
      const outcome = await mergeAccountCredential(provider, accountId, fresh, {
        expectedGeneration: generation,
        afterPrePersistRead: deps.afterPrePersistRead,
        keepReauthMarkedAfterDispatch: !row.needsReauth,
      });
      if (outcome.superseded) {
        if (outcome.stored.expires > now() + REFRESH_SKEW_MS) return outcome.stored.access;
        throw new OAuthLoginRequiredError(provider);
      }
      permanentRefreshFailures.delete(verdictKey(provider, accountId, candidate));
      if (candidate.source === "local-cli") console.warn(XAI_LOCAL_CLI_DETACH_WARNING);
      return fresh.access;
    } catch (error) {
      if (error instanceof OAuthMutationBusyError) {
        permanentRefreshFailures.delete(verdictKey(provider, accountId, candidate));
        throw error;
      }
      if (!isTerminalOAuthRefreshFailure(error)) throw error;
      const failedAt = now();
      permanentRefreshFailures.set(
        verdictKey(provider, accountId, candidate),
        failedAt + XAI_PERMANENT_FAILURE_TTL_MS,
      );
      sweepExpiredOnWrite(failedAt);
      await markAccountNeedsReauthIfGeneration(provider, accountId, generation, writerGeneration);
      throw new OAuthLoginRequiredError(provider);
    }
  } finally {
    guard.release();
  }
}

import { FORWARD_HEADERS } from "../adapters/openai-responses";
import { bindOAuthSnapshotToProvider } from "../lib/provider-egress";
import { AgentAssertionUnsupportedError, authorizationCredential, hasAgentAssertionAuthorization } from "../lib/authorization-scheme";
import { captureConfigGeneration } from "../lib/state-store-sweeper";
import { extractAccountId } from "../oauth/chatgpt";
import type { DataPlaneAdmission } from "../server/auth-cors";
import type { CodexAccountMode, EpxConfig, EpxProviderConfig } from "../types";
import { reconcileMainCodexAccountRuntimeState } from "./account-lifecycle";
import { isCodexAccountGenerationLive } from "./account-store";
import { isCodexAccountUsable } from "./account-usability";
import type { EpxRuntimeProviderConfig } from "./auth-context-provider";
import { NATIVE_RESERVE_MODEL } from "./catalog/native-models";
import { isolateCodexPoolAccountHeaders } from "./forward-transport-headers";
import { isCodexReserveHelperUnsupported } from "./loopback-target";
import { getMainAccountToken, getValidMainAccountToken, isMainAccountTokenLive, type NativeMainRefreshDependencies } from "./main-account";
import { captureMainQuotaDispatch, captureMainQuotaWriter, isMainQuotaWriterLive, type MainQuotaDispatch, type MainQuotaWriter } from "./main-account-cache";
import { isMainAccountHardLockEnabled } from "./main-account-hard-lock";
import { isNativeMainTrafficBlocked } from "./native-profile-startup";
import { poolContextCreditHoldResetAt, poolContextCreditRecoveryNeeded } from "./pool-credit-policy";
import { callerMatchesObservedMain } from "./request-owned-main-pin";
import { isMainReserveAuthorizationLive } from "./reserve-availability";
import { getCodexQuotaHealthSnapshot } from "./routing";
import {
  assertCodexAccountValidationReady,
  assertMainAccountPolicy,
  assertPoolAccountCredits,
  assertReserveAdmission,
  authorizeReserveCredential,
  captureObservedMainWriter,
  type CodexAccountSelectionAdmission,
  CodexAccountCooldownError,
  type CodexAuthContext,
  type CodexAuthPolicyConfig,
  CodexMainProfileDrainingError,
  CodexMainSubstitutionUnavailableError,
  CodexPoolAuthenticationError,
  CodexReserveHelperUnsupportedError,
  CodexReserveUnavailableError,
  hasCallerCodexBearer,
  observeSelectedMainCredential,
  requiresReserveAuthorization,
  selectedCodexToken,
} from "./auth-context-errors";

interface CodexAuthMaterializationOptions {
  substituteMainCredential?: boolean;
  config?: CodexAuthPolicyConfig;
  modelId?: string;
  /** Trusted receiving-listener admission; never inferred from request headers or config. */
  admission?: Pick<DataPlaneAdmission, "source">;
  signal?: AbortSignal;
  nativeMainRefreshDependencies?: NativeMainRefreshDependencies;
  beginCodexAccountSelection?: () => CodexAccountSelectionAdmission | undefined;
}

/**
 * The workspace account id a request-owned `main` credential materializes under, or
 * `undefined` when the caller's headers carry none. This is the `chatgpt-account-id`
 * `materializeCodexUpstreamAuth` would set for a caller-owned `{ kind: "main" }` context,
 * read here without touching a credential store so a rotation gate can compare workspace
 * scope before a send is ever built.
 */
export function callerCodexWorkspaceAccountId(headers: Headers): string | undefined {
  const explicit = headers.get("chatgpt-account-id");
  if (explicit) return explicit;
  const bearer = authorizationCredential(headers);
  return bearer ? extractAccountId(undefined, bearer) : undefined;
}

function assertMaterializedReserve(headers: Headers, ctx: CodexAuthContext, options: CodexAuthMaterializationOptions): void {
  if (!requiresReserveAuthorization(options.config, options.modelId, options.admission)) return;
  assertReserveAdmission(options.config!);
  if (ctx.kind === "pool" || !isMainReserveAuthorizationLive(ctx.reserveAuthorization, selectedCodexToken(headers))) {
    throw new CodexReserveUnavailableError();
  }
}

/** A dispatch never renews permission: the next request may obtain a fresh bounded proof. */
export function createCodexReserveDispatchGuard(
  ctx: CodexAuthContext,
  config: CodexAuthPolicyConfig,
  modelId: string,
  admission?: Pick<DataPlaneAdmission, "source">,
  terminalHelper = false,
): ((headers: Headers) => void) | undefined {
  // Snapshot the resolved source value, not the caller's mutable admission object. Config stays
  // live so policy changes remain visible after pacing and retry backoff.
  const source = admission?.source;
  if (modelId !== NATIVE_RESERVE_MODEL || source !== "loopback") return undefined;
  // Only immutable request facts decide whether to install the callback. Flag/role eligibility
  // is checked inside it, including an opt-in enabled while a send waits for pacing or WS open.
  const ingress = Object.freeze({ source });
  return headers => {
    if (isCodexReserveHelperUnsupported(config, modelId, ingress, terminalHelper)) {
      throw new CodexReserveHelperUnsupportedError();
    }
    assertMaterializedReserve(headers, ctx, { config, modelId, admission: ingress });
  };
}

/** Recheck live account policy at the physical send, after pacing or retry backoff. */
export function createCodexAuthDispatchGuard(
  ctx: CodexAuthContext,
  config: CodexAuthPolicyConfig,
  modelId: string,
  admission?: Pick<DataPlaneAdmission, "source">,
  terminalHelper = false,
): ((headers: Headers) => void) | undefined {
  const reserveGuard = createCodexReserveDispatchGuard(ctx, config, modelId, admission, terminalHelper);
  if (ctx.kind !== "pool" && ctx.kind !== "main-pool") return reserveGuard;
  return headers => {
    if (config.pausedCodexAccountIds?.includes(ctx.accountId)) throw new CodexPoolAuthenticationError("Selected Codex account is paused; resume it in account settings");
    if (ctx.kind === "main-pool") { reserveGuard?.(headers); return; }
    assertPoolAccountCredits(ctx.accountId, poolContextCreditHoldResetAt(ctx, config), poolContextCreditRecoveryNeeded(ctx, config), ctx.quotaScope);
    reserveGuard?.(headers);
  };
}

export function assertCodexAuthContextNotCooled(ctx: CodexAuthContext | undefined): void {
  if (ctx?.kind !== "pool" && ctx?.kind !== "main-pool") return;
  if (ctx.kind === "pool") assertPoolAccountCredits(ctx.accountId, poolContextCreditHoldResetAt(ctx), poolContextCreditRecoveryNeeded(ctx), ctx.quotaScope);
  // A context holding the probe lease was deliberately admitted through the cooldown.
  if (ctx.probeLeaseId) return;
  const cooldown = getCodexQuotaHealthSnapshot(ctx.accountId, ctx.quotaScope);
  if (cooldown?.cooldownUntil) {
    throw new CodexAccountCooldownError(ctx.accountId, cooldown.cooldownUntil, cooldown.cooldownSource, cooldown.quotaScope);
  }
}

export function applyCodexAuthContextToProvider(
  provider: EpxProviderConfig,
  ctx: CodexAuthContext,
  mode: CodexAccountMode | undefined,
): EpxRuntimeProviderConfig {
  if (mode !== "pool" || (ctx.kind !== "pool" && ctx.kind !== "main-pool") || provider.authMode !== "forward") return provider;
  assertCodexAccountValidationReady(ctx.accountId);
  if (ctx.kind === "pool") assertPoolAccountCredits(ctx.accountId, poolContextCreditHoldResetAt(ctx), poolContextCreditRecoveryNeeded(ctx), ctx.quotaScope);
  const pinnedProvider = bindOAuthSnapshotToProvider(provider, ctx.kind === "pool" ? { proxy: ctx.proxy } : {});
  return {
    ...pinnedProvider,
    _codexAccountOverride: {
      accessToken: ctx.accessToken,
      chatgptAccountId: ctx.chatgptAccountId,
      kind: ctx.kind,
    },
    _codexAccountRequired: true,
  };
}

/** Dispatch identity comes only from an owned observation of the selected credential. */
function selectedMainQuotaDispatch(selected: Headers): MainQuotaDispatch | undefined {
  const bearer = authorizationCredential(selected);
  if (!bearer) return undefined;
  const accountId = selected.get("chatgpt-account-id") ?? extractAccountId(undefined, bearer);
  return captureMainQuotaDispatch(bearer, accountId, captureConfigGeneration());
}

/**
 * Build the upstream auth headers for one Codex turn.
 *
 * The two credential domains meet here, and only here:
 *
 * - `pool` / `main-pool` always OVERWRITE with the stored account credential. Whatever the
 *   caller sent is irrelevant to what we send upstream.
 * - `main` with an admission-bearer caller (#1686) must substitute the stored main credential.
 *   The caller proved admission with one of OUR secrets, which must never leave the process, so
 *   the only two acceptable outcomes are replaced-with-stored-main or fail-before-any-IO.
 *   Silently forwarding would be the leak validateForwardAdmissionCredential exists to prevent.
 * - `main` with a dedicated-header caller keeps the existing intentional passthrough: the bearer
 *   there is the user's own ChatGPT credential, not ours.
 */
export function materializeCodexUpstreamAuth(
  headers: Headers,
  ctx: CodexAuthContext,
  options: CodexAuthMaterializationOptions = {},
): Headers {
  // assertion_only must never be answered with a pool, stored-main, or other substituted Bearer.
  if (hasAgentAssertionAuthorization(headers)) throw new AgentAssertionUnsupportedError();
  if (ctx.kind === "main") ctx.mainQuotaDispatch = undefined;
  const selected = new Headers();
  for (const name of FORWARD_HEADERS) {
    const value = headers.get(name);
    if (value || (value !== null && (name === "x-codex-installation-id" || name === "x-codex-turn-metadata"))) selected.set(name, value);
  }
  if (ctx.kind === "pool" || ctx.kind === "main-pool") {
    assertCodexAccountValidationReady(ctx.accountId);
    if (ctx.kind === "pool") assertPoolAccountCredits(ctx.accountId, poolContextCreditHoldResetAt(ctx, options.config), poolContextCreditRecoveryNeeded(ctx, options.config), ctx.quotaScope);
    selected.set("authorization", `Bearer ${ctx.accessToken}`);
    selected.set("chatgpt-account-id", ctx.chatgptAccountId);
    if (ctx.kind === "pool") isolateCodexPoolAccountHeaders(selected, ctx.chatgptAccountId);
    else selected.delete("x-oai-attestation");
    if (ctx.kind === "main-pool") {
      ctx.mainQuotaWriter = observeSelectedMainCredential(ctx, ctx.mainQuotaWriter);
      assertMainAccountPolicy(options.config);
      ctx.mainQuotaDispatch = ctx.mainQuotaWriter && isMainQuotaWriterLive(ctx.mainQuotaWriter)
        ? selectedMainQuotaDispatch(selected) : undefined;
    }
    assertMaterializedReserve(selected, ctx, options);
    return selected;
  }
  if (ctx.kind === "main" && options.substituteMainCredential !== true
    && !selected.has("chatgpt-account-id")) {
    const bearer = authorizationCredential(selected);
    const accountId = bearer ? extractAccountId(undefined, bearer) : undefined;
    if (accountId) selected.set("chatgpt-account-id", accountId);
  }
  if (ctx.kind === "main" && options.substituteMainCredential === true) {
    // No config object is "no policy input", not the persisted opt-out: only a config that
    // actually says `false` disables the default-on lock (#5694).
    if (options.config !== undefined && isMainAccountHardLockEnabled(options.config)) {
      reconcileMainCodexAccountRuntimeState();
    }
    const writer = captureObservedMainWriter();
    const stored = getMainAccountToken();
    // Fail BEFORE any upstream I/O. Falling through here would send the admission secret.
    if (!stored?.accessToken || !isMainAccountTokenLive()) {
      throw new CodexMainSubstitutionUnavailableError();
    }
    selected.delete("chatgpt-account-id");
    selected.set("authorization", `Bearer ${stored.accessToken}`);
    if (stored.chatgptAccountId) selected.set("chatgpt-account-id", stored.chatgptAccountId);
    selected.delete("x-oai-attestation");
    observeSelectedMainCredential(stored, writer);
    assertMainAccountPolicy(options.config);
    assertMaterializedReserve(selected, ctx, options);
    ctx.mainQuotaDispatch = selectedMainQuotaDispatch(selected);
    return selected;
  }
  if (callerMatchesObservedMain(selected)) assertMainAccountPolicy(options.config);
  assertMaterializedReserve(selected, ctx, options);
  if (ctx.kind === "main") ctx.mainQuotaDispatch = selectedMainQuotaDispatch(selected);
  return selected;
}

/** The model producer, not an optional context marker, decides whether a grant is required. */
async function materializeReserveUpstreamAuth(
  headers: Headers,
  ctx: CodexAuthContext,
  options: CodexAuthMaterializationOptions,
): Promise<Headers> {
  if (ctx.kind === "pool") throw new CodexReserveUnavailableError();
  const config = options.config!;
  assertReserveAdmission(config);
  const writerGeneration = ctx.kind === "main-pool" ? ctx.writerGeneration : captureConfigGeneration();
  const storedMain = ctx.kind === "main"
    && (options.substituteMainCredential === true || !hasCallerCodexBearer(headers));
  let admission: CodexAccountSelectionAdmission | undefined;
  let writer = ctx.kind === "main-pool" ? ctx.mainQuotaWriter : undefined;
  try {
    if (storedMain) {
      if (isNativeMainTrafficBlocked()) throw new CodexMainProfileDrainingError();
      admission = options.beginCodexAccountSelection?.();
      if (!admission || admission.mainProfileDraining || !admission.claimMainProfile() || isNativeMainTrafficBlocked()) {
        throw new CodexMainProfileDrainingError();
      }
      reconcileMainCodexAccountRuntimeState();
      writer = captureObservedMainWriter();
      assertReserveAdmission(config);
    }
    // Build the real credential first, without recursively requiring a not-yet-fetched proof.
    // The ordinary hard lock remains enabled, including the post-refresh check.
    const selected = await materializeCodexUpstreamAuthAsync(headers, ctx, {
      ...options, modelId: undefined, substituteMainCredential: storedMain,
    });
    const token = selectedCodexToken(selected);
    if (ctx.kind === "main-pool") writer = ctx.mainQuotaWriter;
    else if (!storedMain) writer = captureMainQuotaWriter(token.chatgptAccountId);
    ctx.reserveAuthorization = await authorizeReserveCredential(token, writer, config, options.signal,
      ctx.reserveAuthorization, writerGeneration);
    assertMaterializedReserve(selected, ctx, options);
    return selected;
  } finally {
    admission?.release();
  }
}

export async function materializeCodexUpstreamAuthAsync(
  headers: Headers,
  ctx: CodexAuthContext,
  options: CodexAuthMaterializationOptions = {},
): Promise<Headers> {
  if (hasAgentAssertionAuthorization(headers)) throw new AgentAssertionUnsupportedError();
  if (ctx.kind === "main") ctx.mainQuotaDispatch = undefined;
  if (requiresReserveAuthorization(options.config, options.modelId, options.admission)) {
    return materializeReserveUpstreamAuth(headers, ctx, options);
  }
  if (ctx.kind !== "main" || options.substituteMainCredential !== true) {
    return materializeCodexUpstreamAuth(headers, ctx, options);
  }
  const selected = new Headers();
  for (const name of FORWARD_HEADERS) {
    const value = headers.get(name);
    if (value || (value !== null && (name === "x-codex-installation-id" || name === "x-codex-turn-metadata"))) selected.set(name, value);
  }
  if (options.config !== undefined && isMainAccountHardLockEnabled(options.config)) {
    reconcileMainCodexAccountRuntimeState();
  }
  const writer = captureObservedMainWriter();
  const stored = await getValidMainAccountToken({
    signal: options.signal,
    ...(options.nativeMainRefreshDependencies ?? {}),
  });
  if (!stored?.accessToken) throw new CodexMainSubstitutionUnavailableError();
  selected.delete("chatgpt-account-id");
  selected.set("authorization", `Bearer ${stored.accessToken}`);
  if (stored.chatgptAccountId) selected.set("chatgpt-account-id", stored.chatgptAccountId);
  selected.delete("x-oai-attestation");
  observeSelectedMainCredential(stored, writer);
  assertMainAccountPolicy(options.config);
  // An opt-in enabled during token refresh must not turn a proof-less context into Reserve.
  assertMaterializedReserve(selected, ctx, options);
  ctx.mainQuotaDispatch = selectedMainQuotaDispatch(selected);
  return selected;
}

/** @deprecated Prefer materializeCodexUpstreamAuth; kept for call sites without admission context. */
export function headersForCodexAuthContext(
  headers: Headers,
  ctx: CodexAuthContext,
  config?: CodexAuthPolicyConfig,
  modelId?: string,
  admission?: Pick<DataPlaneAdmission, "source">,
): Headers {
  return materializeCodexUpstreamAuth(headers, ctx, { config, modelId, admission });
}

export function isCodexAuthContextUsable(ctx: CodexAuthContext, config: EpxConfig): boolean {
  if (ctx.kind === "main") return true;
  if (ctx.kind === "main-pool") {
    return isCodexAccountUsable(config, ctx.accountId, ctx.fixedAccount === true ? { explicitAccountSelector: true } : undefined);
  }
  return isCodexAccountUsable(config, ctx.accountId) && isCodexAccountGenerationLive(ctx.accountId, ctx.generation);
}

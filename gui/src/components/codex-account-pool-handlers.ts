import { createBoundedFetch } from "../bounded-fetch";
import type { TFn } from "../i18n/shared";
import { readJsonIfOk } from "../fetch-json";

export function newCodexResetOperationId(): string | undefined {
  const api = globalThis.crypto;
  if (api && typeof api.randomUUID === "function") return api.randomUUID();
  if (api && typeof api.getRandomValues === "function") {
    const bytes = api.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = [...bytes].map(byte => byte.toString(16).padStart(2, "0")).join("");
    return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join("-");
  }
  return undefined;
}

export interface RedeemResetCreditOptions {
  operationId?: string;
  shouldLoad?: () => boolean;
}

function remainingCreditsToast(
  t: TFn,
  remaining: number | undefined,
): string {
  if (remaining === undefined) return t("codexAuth.resetSuccessGeneric");
  return t("codexAuth.resetSuccess", { remaining: String(remaining) });
}

export async function redeemResetCredit(
  apiBase: string,
  accountId: string,
  t: TFn,
  load: (refresh?: boolean) => Promise<boolean>,
  options?: RedeemResetCreditOptions,
): Promise<{ ok: boolean; toast?: string; close?: boolean; uncertain?: boolean }> {
  const bounded = createBoundedFetch(15_000);
  try {
    const operationId = options?.operationId ?? newCodexResetOperationId();
    const body = operationId ? { accountId, operationId } : { accountId };
    const resp = await fetch(`${apiBase}/api/codex-auth/reset-credits/consume`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: bounded.signal,
    });
    const result = await readJsonIfOk<{ code: string; remaining?: number }>(resp);
    if (!result) {
      const uncertain = !resp.ok && (resp.status >= 500 || resp.status === 408 || resp.status === 429);
      return { ok: false, toast: t("codexAuth.resetError"), uncertain: resp.ok || uncertain };
    }
    if (result.code === "reset" || result.code === "already_redeemed") {
      if (options?.shouldLoad?.() !== false) {
        await load(true);
      }
      // Authoritative remaining comes from the management endpoint (refreshed quota).
      // Never invent a decrement from a stale modal snapshot.
      const remaining =
        typeof result.remaining === "number" && Number.isFinite(result.remaining)
          ? Math.max(0, result.remaining)
          : undefined;
      return {
        ok: true,
        close: true,
        toast: remainingCreditsToast(t, remaining),
      };
    }
    if (result.code === "nothing_to_reset" || result.code === "no_credit") {
      const key = result.code === "nothing_to_reset" ? "codexAuth.resetNothingToReset" : "codexAuth.resetNoCredit";
      return { ok: false, close: true, toast: t(key) };
    }
    return { ok: false, toast: t("codexAuth.resetError"), uncertain: true };
  } catch {
    return { ok: false, toast: t("codexAuth.resetError"), uncertain: true };
  } finally {
    bounded.clear();
  }
}

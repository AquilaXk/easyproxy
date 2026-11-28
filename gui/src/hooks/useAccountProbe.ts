import { useCallback, useLayoutEffect, useRef, useState } from "react";

/** Mirrors `AccountProbeStatus` in src/providers/quota/antigravity-account-probe.ts. */
export const ACCOUNT_PROBE_STATUSES = [
  "ok", "paused", "token_expired", "suspended", "verification_required", "rate_limited", "permission_denied", "error",
] as const;
export type AccountProbeStatus = typeof ACCOUNT_PROBE_STATUSES[number];

export interface AccountProbeResultDto {
  accountId: string;
  status: AccountProbeStatus;
  httpStatus: number | null;
  reason: string | null;
  message: string | null;
  latencyMs?: number;
  quota?: { customWindows?: Array<{ label: string; percent: number }> } | null;
}

/** Providers whose management API implements `POST /api/oauth/accounts/probe`. */
export const ACCOUNT_PROBE_PROVIDERS: ReadonlySet<string> = new Set(["google-antigravity"]);

export type AccountProbeEntry = { result: AccountProbeResultDto; at: number } | { failed: true; at: number };

function isProbeResult(value: unknown): value is AccountProbeResultDto {
  if (!value || typeof value !== "object") return false;
  const row = value as Partial<AccountProbeResultDto>;
  return typeof row.accountId === "string" && typeof row.status === "string"
    && (ACCOUNT_PROBE_STATUSES as readonly string[]).includes(row.status);
}

/** Probe state for one provider's account list; results stay in memory for this view only. */
export function useAccountProbe(apiBase: string, provider: string) {
  const namespace = `${apiBase}\0${provider}`;
  const [originNamespace, setOriginNamespace] = useState(namespace);
  const [entries, setEntries] = useState<Record<string, AccountProbeEntry>>({});
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const [allPending, setAllPending] = useState(false);
  if (originNamespace !== namespace) {
    setOriginNamespace(namespace);
    setEntries({});
    setPending(new Set());
    setAllPending(false);
  }
  const running = useRef(false);
  const mountedRef = useRef(true);
  const epochRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

  useLayoutEffect(() => {
    mountedRef.current = true;
    const seq = ++epochRef.current;
    return () => {
      mountedRef.current = false;
      if (epochRef.current === seq) epochRef.current += 1;
      abortRef.current?.abort();
      abortRef.current = null;
      running.current = false;
    };
  }, [namespace]);

  const probe = useCallback(async (accountIds: readonly string[], all: boolean) => {
    if (running.current || accountIds.length === 0) return;
    const seq = epochRef.current;
    const controller = new AbortController();
    abortRef.current?.abort();
    abortRef.current = controller;
    running.current = true;
    setPending(new Set(accountIds));
    if (all) setAllPending(true);
    const at = Date.now();
    try {
      const response = await fetch(`${apiBase}/api/oauth/accounts/probe`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, ...(all ? {} : { accountId: accountIds[0] }) }),
        signal: controller.signal,
      });
      if (!mountedRef.current || controller.signal.aborted || epochRef.current !== seq) return;
      const json = response.ok ? await response.json().catch(() => null) as { results?: unknown } | null : null;
      if (!mountedRef.current || controller.signal.aborted || epochRef.current !== seq) return;
      const results = Array.isArray(json?.results) ? json.results.filter(isProbeResult) : [];
      setEntries(previous => {
        const next = { ...previous };
        for (const id of accountIds) next[id] = { failed: true, at };
        for (const result of results) next[result.accountId] = { result, at };
        return next;
      });
    } catch {
      if (!mountedRef.current || controller.signal.aborted || epochRef.current !== seq) return;
      setEntries(previous => {
        const next = { ...previous };
        for (const id of accountIds) next[id] = { failed: true, at };
        return next;
      });
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      if (mountedRef.current && epochRef.current === seq) {
        running.current = false;
        setPending(new Set());
        if (all) setAllPending(false);
      }
    }
  }, [apiBase, provider]);

  return {
    entries,
    busy: pending.size > 0,
    isPending: (accountId: string) => pending.has(accountId),
    allPending,
    probeOne: (accountId: string) => probe([accountId], false),
    probeAll: (accountIds: readonly string[]) => probe(accountIds, true),
  };
}

export type AccountProbeController = ReturnType<typeof useAccountProbe>;

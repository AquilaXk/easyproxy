import { useEffect, useState } from "react";
import { hostDocumentHidden, onHostVisibilityChange } from "../host-visibility";

export interface GatewayAlerts {
  budgetWarningCount: number;
  rateLimitOrBlockCount: number;
}

const EMPTY_ALERTS: GatewayAlerts = { budgetWarningCount: 0, rateLimitOrBlockCount: 0 };
const ALERT_POLL_INTERVAL_MS = 60_000;
const BUDGET_WARN_RATIO = 0.8;

export function countBudgetWarningKeys(keys: unknown): number {
  if (!Array.isArray(keys)) return 0;
  let count = 0;
  for (const row of keys) {
    if (!row || typeof row !== "object") continue;
    const rec = row as {
      dailyCostLimitUsd?: unknown;
      budgetUsage?: { dailyCostUsdUsed?: unknown; dailyCostUsedUsd?: unknown } | null;
    };
    const limit = typeof rec.dailyCostLimitUsd === "number" && Number.isFinite(rec.dailyCostLimitUsd)
      ? rec.dailyCostLimitUsd
      : 0;
    if (limit <= 0) continue;
    const rawUsed = rec.budgetUsage?.dailyCostUsdUsed ?? rec.budgetUsage?.dailyCostUsedUsd;
    const used = typeof rawUsed === "number" && Number.isFinite(rawUsed) && rawUsed >= 0 ? rawUsed : 0;
    if (used / limit >= BUDGET_WARN_RATIO) count += 1;
  }
  return count;
}

export function countRecentRateLimitOrBlockLogs(logs: unknown): number {
  if (!Array.isArray(logs)) return 0;
  let count = 0;
  for (const row of logs) {
    if (!row || typeof row !== "object") continue;
    const rec = row as { status?: unknown; errorCode?: unknown; failureCause?: unknown };
    const isRateLimit = rec.status === 429 || rec.failureCause === "rate-limit";
    const isGuardrailBlock = rec.errorCode === "outbound_secret_guard";
    if (isRateLimit || isGuardrailBlock) count += 1;
  }
  return count;
}

async function fetchAlertsSnapshot(apiBase: string, signal: AbortSignal): Promise<GatewayAlerts> {
  const [keysRes, logsRes] = await Promise.allSettled([
    fetch(`${apiBase}/api/keys`, { signal }),
    fetch(`${apiBase}/api/logs?limit=25`, { signal }),
  ]);

  let budgetWarningCount = 0;
  if (keysRes.status === "fulfilled" && keysRes.value.ok) {
    try {
      const body = (await keysRes.value.json()) as { keys?: unknown } | null;
      budgetWarningCount = countBudgetWarningKeys(body?.keys);
    } catch {
      budgetWarningCount = 0;
    }
  }

  let rateLimitOrBlockCount = 0;
  if (logsRes.status === "fulfilled" && logsRes.value.ok) {
    try {
      const body = (await logsRes.value.json()) as { logs?: unknown } | null;
      rateLimitOrBlockCount = countRecentRateLimitOrBlockLogs(body?.logs);
    } catch {
      rateLimitOrBlockCount = 0;
    }
  }

  return { budgetWarningCount, rateLimitOrBlockCount };
}

export function useGatewayAlerts({ apiBase, ready }: { apiBase: string; ready: boolean }): GatewayAlerts {
  const [alerts, setAlerts] = useState<GatewayAlerts>(EMPTY_ALERTS);

  useEffect(() => {
    if (!ready) {
      return;
    }

    let disposed = false;
    let activeController: AbortController | null = null;

    const run = () => {
      if (disposed || hostDocumentHidden()) return;
      activeController?.abort();
      const controller = new AbortController();
      activeController = controller;
      void fetchAlertsSnapshot(apiBase, controller.signal).then((next) => {
        if (disposed || controller.signal.aborted) return;
        setAlerts((prev) =>
          prev.budgetWarningCount === next.budgetWarningCount && prev.rateLimitOrBlockCount === next.rateLimitOrBlockCount
            ? prev
            : next,
        );
      });
    };

    run();
    const timer = window.setInterval(run, ALERT_POLL_INTERVAL_MS);
    const unsubVisibility = onHostVisibilityChange(() => {
      if (!hostDocumentHidden()) run();
    });

    return () => {
      disposed = true;
      window.clearInterval(timer);
      unsubVisibility();
      activeController?.abort();
    };
  }, [apiBase, ready]);

  return ready ? alerts : EMPTY_ALERTS;
}

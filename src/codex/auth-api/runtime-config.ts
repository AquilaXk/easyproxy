import { loadConfig, saveConfigPreservingClaudeCode } from "../../config";
import { codexPlanValue } from "../plan";
import type { CodexAccount, EpxConfig } from "../../types";
import { isSelectableCodexPoolAccount, isValidCodexAccountId } from "../account-id";

export function configuredPoolAccount(config: EpxConfig, accountId: string): CodexAccount | null {
  if (!isValidCodexAccountId(accountId)) return null;
  return (config.codexAccounts ?? [])
    .find(account => account.id === accountId && isSelectableCodexPoolAccount(account)) ?? null;
}

export function nonEmptyPlan(value: unknown): string | null {
  return codexPlanValue(value) ?? null;
}

export function isRuntimeConfig(config: EpxConfig): boolean {
  return !!config && typeof config === "object" && !!config.providers;
}

export function getRuntimeConfig(config: EpxConfig): EpxConfig {
  return isRuntimeConfig(config) ? config : loadConfig();
}

export function saveRuntimeConfig(sourceConfig: EpxConfig, nextConfig: EpxConfig): void {
  saveConfigPreservingClaudeCode(nextConfig);
  if (sourceConfig === nextConfig || !isRuntimeConfig(sourceConfig)) return;
  for (const key of Object.keys(sourceConfig) as Array<keyof EpxConfig>) {
    delete sourceConfig[key];
  }
  Object.assign(sourceConfig, nextConfig);
}

export async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await mapper(items[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}

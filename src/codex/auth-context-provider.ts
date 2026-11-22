import type { EpxProviderConfig } from "../types";

export type EpxRuntimeProviderConfig = EpxProviderConfig & {
  _codexAccountOverride?: { accessToken: string; chatgptAccountId: string; kind?: "pool" | "main-pool" };
  _codexAccountRequired?: boolean;
};

export function stripCodexRuntimeProviderFields(provider: EpxProviderConfig): EpxProviderConfig {
  const {
    _codexAccountOverride: _override,
    _codexAccountRequired: _required,
    ...safeProvider
  } = provider as EpxRuntimeProviderConfig;
  return safeProvider;
}

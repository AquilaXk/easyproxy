import type { AdmissionModelScope } from "../server/admission-model-scope";
import type { EpxFallbackConfig } from "./fallback";

/** Credential-free, immutable decision inputs captured for an internal child. */
export interface CapturedAdmissionPolicy {
  readonly modelScope: AdmissionModelScope;
  readonly allowMeteredComboTargets: boolean;
  readonly meteredRequiresComboOptIn: boolean;
  readonly fallbackPolicies: readonly {
    readonly config: { readonly fallback?: EpxFallbackConfig };
    readonly deviceIds: readonly string[];
  }[];
}

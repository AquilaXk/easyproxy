/** Kiro login identity and persisted evidence entrypoints. */
import {
  kiroEvidenceIdentity,
  sanitizeKiroQuota,
  type KiroPersistedQuota,
  type KiroPersistedVerdict,
} from "./kiro-account-evidence";
import { hydrateAccountQuotaCache, persistAccountQuotaCache } from "./quota/account-cache";

export {
  kiroEvidenceIdentity,
  sanitizeKiroQuota,
  type KiroPersistedQuota,
  type KiroPersistedVerdict,
};

export function hydrateKiroAccountState(): void { hydrateAccountQuotaCache(); }
export function persistKiroAccountState(): void { persistAccountQuotaCache(); }

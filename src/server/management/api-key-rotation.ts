import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { parseStrictTimestampMs } from "../../lib/strict-timestamp";
import type { EpxConfig } from "../../types";

export const API_KEY_ROTATION_TTL_MS = 10 * 60_000;

export type ApiKeyRotationStart = {
  id: string;
  name: string;
  key: string;
  createdAt: string;
  rotationId: string;
  expiresAt: string;
};

function equalOpaqueId(left: string, right: string): boolean {
  const encoder = new TextEncoder();
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function removeExpiredApiKeyRotations(config: EpxConfig, now = Date.now()): boolean {
  let changed = false;
  for (const entry of config.apiKeys ?? []) {
    if (!entry.pendingRotation) continue;
    const expiresMs = typeof entry.pendingRotation.expiresAt === "string"
      ? parseStrictTimestampMs(entry.pendingRotation.expiresAt)
      : Number.NaN;
    if (!Number.isFinite(expiresMs) || expiresMs <= now) {
      delete entry.pendingRotation;
      changed = true;
    }
  }
  return changed;
}

export function startApiKeyRotation(
  config: EpxConfig,
  keyId: string,
  now = Date.now(),
): ApiKeyRotationStart | { error: "not-found" | "already-pending" } {
  const entry = (config.apiKeys ?? []).find(candidate => candidate.id === keyId);
  if (!entry) return { error: "not-found" };
  const pendingExpiresMs = entry.pendingRotation && typeof entry.pendingRotation.expiresAt === "string"
    ? parseStrictTimestampMs(entry.pendingRotation.expiresAt)
    : Number.NaN;
  if (Number.isFinite(pendingExpiresMs) && pendingExpiresMs > now) {
    return { error: "already-pending" };
  }
  const key = `epx_data_${randomBytes(20).toString("hex")}`;
  const rotationId = randomUUID();
  const createdAt = new Date(now).toISOString();
  const expiresAt = new Date(now + API_KEY_ROTATION_TTL_MS).toISOString();
  entry.pendingRotation = { id: rotationId, key, createdAt, expiresAt };
  return { id: entry.id, name: entry.name, key, createdAt, rotationId, expiresAt };
}

export function commitApiKeyRotation(
  config: EpxConfig,
  keyId: string,
  rotationId: string,
  now = Date.now(),
): { ok: true } | { error: "not-found" | "expired" | "mismatch" } {
  const entry = (config.apiKeys ?? []).find(candidate => candidate.id === keyId);
  if (!entry?.pendingRotation) return { error: "not-found" };
  const pending = entry.pendingRotation;
  const expiresMs = typeof pending.expiresAt === "string" ? parseStrictTimestampMs(pending.expiresAt) : Number.NaN;
  if (!Number.isFinite(expiresMs) || expiresMs <= now) {
    delete entry.pendingRotation;
    return { error: "expired" };
  }
  if (!equalOpaqueId(pending.id, rotationId)) return { error: "mismatch" };
  entry.key = pending.key;
  delete entry.pendingRotation;
  return { ok: true };
}

export function abortApiKeyRotation(config: EpxConfig, keyId: string, rotationId: string): boolean {
  const entry = (config.apiKeys ?? []).find(candidate => candidate.id === keyId);
  if (!entry?.pendingRotation || !equalOpaqueId(entry.pendingRotation.id, rotationId)) return false;
  delete entry.pendingRotation;
  return true;
}

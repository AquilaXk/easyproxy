#!/usr/bin/env bun
/**
 * Fail-fast release credential and repository variable validator.
 *
 * Runs in the lightweight verify job before spawning cross-platform desktop
 * runners so a real publish missing signing keys fails immediately instead of
 * wasting runner builds. Never prints secret values.
 */
const REQUIRED_APPLE_VARS = [
  "APPLE_CERTIFICATE",
  "APPLE_CERTIFICATE_PASSWORD",
  "APPLE_SIGNING_IDENTITY",
  "APPLE_ID",
  "APPLE_PASSWORD",
  "APPLE_TEAM_ID",
] as const;

const REQUIRED_SIGNPATH_VARS = [
  "SIGNPATH_API_TOKEN",
  "SIGNPATH_ORGANIZATION_ID",
  "SIGNPATH_PROJECT_SLUG",
  "SIGNPATH_SIGNING_POLICY_SLUG",
] as const;

export function collectReleaseCredentialErrors(env: Record<string, string | undefined>): string[] {
  if (env.DRY_RUN === "true") {
    return [];
  }

  const errors: string[] = [];

  for (const key of REQUIRED_APPLE_VARS) {
    if (!(env[key] ?? "").trim()) {
      errors.push(`Missing ${key} required for macOS Developer ID signing and notarization.`);
    }
  }
  const teamId = (env.APPLE_TEAM_ID ?? "").trim();
  if (teamId && !/^[A-Z0-9]{10}$/.test(teamId)) {
    errors.push("APPLE_TEAM_ID must be 10 uppercase alphanumeric characters.");
  }

  if (!(env.TAURI_SIGNING_PRIVATE_KEY ?? "").trim()) {
    errors.push("Missing TAURI_SIGNING_PRIVATE_KEY required for signed updater artifacts.");
  }

  for (const key of REQUIRED_SIGNPATH_VARS) {
    if (!(env[key] ?? "").trim()) {
      errors.push(`Missing ${key} required for Windows SignPath release signing.`);
    }
  }
  const orgId = (env.SIGNPATH_ORGANIZATION_ID ?? "").trim();
  if (orgId && !/^[A-Za-z0-9_-]+$/.test(orgId)) {
    errors.push("SIGNPATH_ORGANIZATION_ID contains invalid characters.");
  }
  const projectSlug = (env.SIGNPATH_PROJECT_SLUG ?? "").trim();
  if (projectSlug && !/^[A-Za-z0-9_-]+$/.test(projectSlug)) {
    errors.push("SIGNPATH_PROJECT_SLUG contains invalid characters.");
  }
  const policySlug = (env.SIGNPATH_SIGNING_POLICY_SLUG ?? "").trim();
  if (policySlug && policySlug !== "release-signing") {
    errors.push(
      `SIGNPATH_SIGNING_POLICY_SLUG must be 'release-signing' for real releases (got '${policySlug}').`,
    );
  }
  return errors;
}

export function validateReleaseCredentials(env: Record<string, string | undefined>): void {
  if (env.DRY_RUN === "true") {
    console.log("[release-verify] dry-run=true; skipping signing credential enforcement.");
    return;
  }
  const errors = collectReleaseCredentialErrors(env);
  if (errors.length > 0) {
    for (const message of errors) {
      console.error(`::error::${message}`);
    }
    throw new Error(`Release credential check failed (${errors.length} issue(s))`);
  }
  console.log("[release-verify] All signing and updater credentials validated.");
}

if (import.meta.main) {
  validateReleaseCredentials(process.env);
}

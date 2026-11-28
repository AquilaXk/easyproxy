#!/usr/bin/env bun
/**
 * Fail-fast release credential and repository variable validator.
 *
 * Runs in the lightweight verify job before spawning cross-platform desktop
 * runners so a misconfigured real publish fails immediately instead of wasting
 * runner builds. Never prints secret values.
 *
 * Platform code signing is optional until the accounts exist (QA 2026-11-28):
 *   - Apple: all six secrets empty ships ad-hoc signed and not notarized; all six set
 *     signs and notarizes; any partial set is a configuration mistake and fails.
 *   - SignPath: no API token ships unsigned Windows binaries; a token needs the three
 *     repository variables and a policy of release-signing (signs) or test-signing
 *     (ships unsigned); any other slug is a typo and fails (scripts/ci/windows-signing-plan.sh).
 * The updater signing key stays mandatory for a real release.
 */
const REQUIRED_APPLE_VARS = [
  "APPLE_CERTIFICATE",
  "APPLE_CERTIFICATE_PASSWORD",
  "APPLE_SIGNING_IDENTITY",
  "APPLE_ID",
  "APPLE_PASSWORD",
  "APPLE_TEAM_ID",
] as const;

/**
 * Policies a real release accepts, matching scripts/ci/windows-signing-plan.sh: release-signing signs,
 * test-signing ships unsigned. Any other slug is a typo and fails.
 */
const ALLOWED_SIGNPATH_POLICIES = ["release-signing", "test-signing"] as const;

/** Required once SIGNPATH_API_TOKEN is set. */
const REQUIRED_SIGNPATH_VARS = [
  "SIGNPATH_ORGANIZATION_ID",
  "SIGNPATH_PROJECT_SLUG",
  "SIGNPATH_SIGNING_POLICY_SLUG",
] as const;

export type CredentialSetState = "none" | "all" | "partial";

/** Whether none, all, or only some of the named variables are non-empty; `missing` lists the empty names. */
export function classifyCredentialSet(
  env: Record<string, string | undefined>,
  names: readonly string[],
): { state: CredentialSetState; missing: string[] } {
  const missing = names.filter(name => !(env[name] ?? "").trim());
  const state = missing.length === 0 ? "all" : missing.length === names.length ? "none" : "partial";
  return { state, missing };
}

export function collectReleaseCredentialErrors(env: Record<string, string | undefined>): string[] {
  if (env.DRY_RUN === "true") {
    return [];
  }

  const errors: string[] = [];

  const apple = classifyCredentialSet(env, REQUIRED_APPLE_VARS);
  if (apple.state === "partial") {
    errors.push(
      `Apple signing secrets are partially configured; set all six or none. Missing: ${apple.missing.join(", ")}.`,
    );
  }
  const teamId = (env.APPLE_TEAM_ID ?? "").trim();
  if (teamId && !/^[A-Z0-9]{10}$/.test(teamId)) {
    errors.push("APPLE_TEAM_ID must be 10 uppercase alphanumeric characters.");
  }

  if (!(env.TAURI_SIGNING_PRIVATE_KEY ?? "").trim()) {
    errors.push("Missing TAURI_SIGNING_PRIVATE_KEY required for signed updater artifacts.");
  }

  if ((env.SIGNPATH_API_TOKEN ?? "").trim()) {
    for (const key of REQUIRED_SIGNPATH_VARS) {
      if (!(env[key] ?? "").trim()) {
        errors.push(`Missing ${key}; SIGNPATH_API_TOKEN is set, so Windows SignPath signing must be fully configured.`);
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
    if (policySlug && !/^[a-z0-9-]+$/.test(policySlug)) {
      errors.push("SIGNPATH_SIGNING_POLICY_SLUG is not a lowercase slug.");
    } else if (policySlug && !(ALLOWED_SIGNPATH_POLICIES as readonly string[]).includes(policySlug)) {
      errors.push(
        `SIGNPATH_SIGNING_POLICY_SLUG must be one of ${ALLOWED_SIGNPATH_POLICIES.join(", ")} (got '${policySlug}').`,
      );
    }
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
  if (classifyCredentialSet(env, REQUIRED_APPLE_VARS).state === "none") {
    console.log("[release-verify] Apple signing secrets are not configured; macOS builds ship ad-hoc signed and not notarized.");
  }
  if (!(env.SIGNPATH_API_TOKEN ?? "").trim()) {
    console.log("[release-verify] SIGNPATH_API_TOKEN is not configured; Windows builds ship unsigned.");
  }
  console.log("[release-verify] Updater credentials and configured signing credentials validated.");
}

if (import.meta.main) {
  validateReleaseCredentials(process.env);
}

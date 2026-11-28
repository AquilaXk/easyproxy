#!/usr/bin/env bash
# Decide whether this release run Authenticode-signs its Windows binaries through SignPath (#7207).
#
# Inputs (environment):
#   SIGNPATH_CONFIGURED        "true" when the SIGNPATH_API_TOKEN secret is visible to this run
#   SIGNPATH_ORGANIZATION_ID   repository variable
#   SIGNPATH_PROJECT_SLUG      repository variable
#   SIGNPATH_SIGNING_POLICY    repository variable SIGNPATH_SIGNING_POLICY_SLUG
#   DRY_RUN                    the dispatch's dry-run input ("true" or "false")
#   GITHUB_OUTPUT              step output file
#
# Outputs: mode=sign|skip, policy=<slug>, trust=release|test
#
# Windows signing is optional until a SignPath account exists (QA 2026-11-28). Only a configuration
# mistake blocks a real release; an unconfigured or test-only setup ships unsigned binaries:
#   - No token: skip with a notice, for dry runs and real releases alike.
#   - A token with a SignPath variable missing, or a value that is not a plain slug: a real release
#     fails; a dry run skips with a warning.
#   - release-signing: sign; the verifier then requires a trusted chain (trust=release).
#   - test-signing: sign dry runs only (trust=test). A self-signed test certificate is never attached
#     to a public release, so a real release skips with a notice and ships unsigned.
#   - Any other policy slug (a typo): a real release fails, so a misspelled release-signing never
#     ships unsigned by accident. A dry run signs it with test trust.
# scripts/ci/verify-release-credentials.ts applies the same policy allowlist upfront.
# The release body states the outcome from the records scripts/ci/windows-signing-outcome.sh writes.
set -euo pipefail

output="${GITHUB_OUTPUT:?GITHUB_OUTPUT is required}"
configured="${SIGNPATH_CONFIGURED:-false}"
org_id="${SIGNPATH_ORGANIZATION_ID:-}"
project="${SIGNPATH_PROJECT_SLUG:-}"
policy="${SIGNPATH_SIGNING_POLICY:-}"
dry_run="${DRY_RUN:-}"

emit() {
  {
    echo "mode=$1"
    echo "policy=$2"
    echo "trust=$3"
  } >> "$output"
}

fail_or_skip() {
  local level="$1"
  local message="$2"
  if [ "$dry_run" = "true" ]; then
    echo "${level}${message} Windows binaries stay unsigned."
    emit skip "" ""
    exit 0
  fi
  echo "::error::$message"
  exit 1
}

if [ "$configured" != "true" ]; then
  echo "::notice::SIGNPATH_API_TOKEN is not configured; Windows binaries ship unsigned."
  emit skip "" ""
  exit 0
fi

missing=""
[ -n "$org_id" ] || missing="$missing SIGNPATH_ORGANIZATION_ID"
[ -n "$project" ] || missing="$missing SIGNPATH_PROJECT_SLUG"
[ -n "$policy" ] || missing="$missing SIGNPATH_SIGNING_POLICY_SLUG"
if [ -n "$missing" ]; then
  fail_or_skip "::warning::" "SIGNPATH_API_TOKEN is set but repository variables are missing:$missing."
fi

# Reject whitespace or control characters that could forge workflow outputs or API slugs.
case "$org_id" in
  *[!A-Za-z0-9_-]*)
    fail_or_skip "::warning::" "SIGNPATH_ORGANIZATION_ID contains invalid characters."
    ;;
esac

case "$project" in
  *[!A-Za-z0-9_-]*)
    fail_or_skip "::warning::" "SIGNPATH_PROJECT_SLUG contains invalid characters."
    ;;
esac

case "$policy" in
  *[!a-z0-9-]*)
    fail_or_skip "::warning::" "SIGNPATH_SIGNING_POLICY_SLUG is not a lowercase slug."
    ;;
esac

if [ "$policy" = "release-signing" ]; then
  echo "Signing Windows binaries with the release-signing policy."
  echo "Each signing request waits for manual approval in app.signpath.io."
  emit sign "$policy" release
  exit 0
fi

if [ "$dry_run" = "true" ]; then
  echo "Signing Windows binaries with the $policy policy for this dry run."
  emit sign "$policy" test
  exit 0
fi

if [ "$policy" = "test-signing" ]; then
  echo "::notice::SIGNPATH_SIGNING_POLICY_SLUG is 'test-signing'. A test certificate is never attached to a release, so Windows binaries ship unsigned."
  emit skip "" ""
  exit 0
fi

echo "::error::SIGNPATH_SIGNING_POLICY_SLUG is '$policy', which is neither release-signing nor test-signing."
exit 1

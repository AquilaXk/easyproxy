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
# Signing is an improvement layered on a release, never a gate on it: this script always exits 0,
# and every outcome other than "sign" ships the unsigned binaries exactly as before.
#   - No token: skip. Forks and unconfigured copies never see the secret.
#   - A token with a SignPath variable missing, or a policy that is not a plain slug: skip with a
#     warning, so the misconfiguration is visible without costing the release.
#   - release-signing: sign; the verifier then requires a trusted chain (trust=release).
#   - Any other policy (test-signing): sign dry runs only (trust=test). A self-signed test
#     certificate is never attached to a public release, so a real release skips with a notice.
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
  if [ "$dry_run" = "true" ]; then
    echo "SignPath is not configured for this dry run; Windows binaries stay unsigned."
    emit skip "" ""
    exit 0
  fi
  echo "::error::SIGNPATH_API_TOKEN is not configured; release builds refuse to ship unsigned Windows binaries."
  exit 1
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

echo "::error::SIGNPATH_SIGNING_POLICY_SLUG is '$policy', not release-signing. Release builds refuse to ship unsigned or test-signed Windows binaries."
exit 1

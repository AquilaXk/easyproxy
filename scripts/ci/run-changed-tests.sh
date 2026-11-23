#!/usr/bin/env bash
# Changed-file test runner for `.github/workflows/ci.yml` (`gates`).
#
# Runs only the test files Bun's parsed import graph reaches from the pushed or
# pull-request diff against BASE_SHA (falling back to HEAD^1 when BASE_SHA is
# absent, all-zeros, or not present in the local checkout). Isolated storage and
# usage API test families stay out of the shared pool and execute in dedicated
# fresh processes whenever storage, usage, or management paths change.
#
# A diff that reaches no test file is not a failure here: `gates` already
# typechecked and linted it, and scripts/test.ts reports that case as an error
# only so a local run does not mistake "nothing selected" for "tested".
set -euo pipefail

# One runner instead of four shards: allow a wide selection up to 25 minutes.
export EPX_TEST_MAIN_TIMEOUT_MS="${EPX_TEST_MAIN_TIMEOUT_MS:-1500000}"

base=""
if [ -n "${BASE_SHA:-}" ] && [ "${BASE_SHA}" != "0000000000000000000000000000000000000000" ] \
  && git cat-file -e "${BASE_SHA}^{commit}" 2>/dev/null; then
  base="$(git merge-base "${BASE_SHA}" HEAD || true)"
fi
if [ -z "$base" ]; then
  base="$(git rev-parse --verify --quiet 'HEAD^1^{commit}' || true)"
fi
if [ -z "$base" ]; then
  echo "::error::run-changed-tests.sh needs BASE_SHA or the commit's first parent; check out with fetch-depth: 0 or >= 2." >&2
  exit 1
fi
echo "changed selection against ${base}"

log="$(mktemp)"
trap 'rm -f "$log"' EXIT

# api-storage* and api-usage keep fresh-process isolation; exclude them from
# the shared --changed pool and run each affected family below in isolation.
set +e
bun scripts/test.ts "--changed=${base}" \
  --path-ignore-patterns='**/api-storage-policy*.test.ts' \
  --path-ignore-patterns='**/api-storage.test.ts' \
  --path-ignore-patterns='**/api-usage.test.ts' 2>&1 | tee "$log"
status="${PIPESTATUS[0]}"
set -e

if [ "$status" -ne 0 ] && grep -Eq 'no test files are affected|selected 0 tests across 0 files|No tests found!' "$log" \
  && ! grep -Eq '^\s*[1-9][0-9]* fail\b' "$log"; then
  echo "::notice::No test file imports a changed module. gates covered this diff; cross-platform smoke checks still run."
  status=0
fi

changed_files="$(git diff --name-only "${base}..HEAD" || true)"
if printf '%s\n' "$changed_files" | grep -Eq '^(src/(storage|usage)/|src/server/(usage|management/.*(storage|usage))|tests/.*api-(storage|usage))'; then
  storage_tests=()
  while IFS= read -r file; do
    [ -n "$file" ] && storage_tests+=("$file")
  done < <(find tests/storage -maxdepth 1 -type f \( -name 'api-storage.test.ts' -o -name 'api-storage-policy*.test.ts' \) | sort)
  for file in "${storage_tests[@]}"; do
    echo "running isolated storage test: ${file}"
    if ! bun scripts/test.ts "./${file}"; then
      status=1
    fi
  done
  if [ -f "tests/server/api-usage.test.ts" ]; then
    echo "running isolated usage test: tests/server/api-usage.test.ts"
    if ! bun scripts/test.ts ./tests/server/api-usage.test.ts; then
      status=1
    fi
  fi
fi

# Read-as-data guards the import graph never selects. The file-size ratchet is
# the one that most often goes red only after two concurrent merges.
if ! bun scripts/test.ts ./tests/ci-workflows/file-size-ratchet.test.ts; then
  status=1
fi

exit "$status"

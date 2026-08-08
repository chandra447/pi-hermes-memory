#!/usr/bin/env bash
# Run each test file in its own tsx process to avoid node:test runner hang.
set -euo pipefail
PASS=0

TEST_TIMEOUT="${TEST_TIMEOUT:-120}"
if [[ ! "$TEST_TIMEOUT" =~ ^[0-9]+([.][0-9]+)?$ ]]; then
  echo "Invalid TEST_TIMEOUT: $TEST_TIMEOUT (expected a non-negative number of seconds)" >&2
  exit 2
fi

TIMEOUT_BIN=()
if [[ ! "$TEST_TIMEOUT" =~ ^0+([.]0+)?$ ]]; then
  if command -v timeout >/dev/null 2>&1; then
    TIMEOUT_BIN=(timeout)
  elif command -v gtimeout >/dev/null 2>&1; then
    TIMEOUT_BIN=(gtimeout)
  fi
fi

run_test_file() {
  local file="$1"
  if ((${#TIMEOUT_BIN[@]} > 0)); then
    "${TIMEOUT_BIN[@]}" --kill-after=5s "$TEST_TIMEOUT" npx tsx --test "$file"
  else
    npx tsx --test "$file"
  fi
}

for f in $(find tests -name '*.test.ts' | sort); do
  echo "--- $f ---"
  if run_test_file "$f"; then
    PASS=$((PASS + 1))
  else
    rc=$?
    if [[ "$rc" -eq 124 && ${#TIMEOUT_BIN[@]} -gt 0 ]]; then
      echo "TIMEOUT (>${TEST_TIMEOUT}s): $f"
    else
      echo "FAILED (exit $rc): $f"
    fi
    exit 1
  fi
done

echo "All $PASS test files passed"

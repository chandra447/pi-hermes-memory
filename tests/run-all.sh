#!/usr/bin/env bash
# Run each test file in its own tsx process to avoid node:test runner hang.
set -euo pipefail

PASS=0

for f in $(find tests -name '*.test.ts' | sort); do
  echo "--- $f ---"
  npx tsx --test "$f" || { echo "FAILED: $f"; exit 1; }
  PASS=$((PASS + 1))
done

echo "All $PASS test files passed"

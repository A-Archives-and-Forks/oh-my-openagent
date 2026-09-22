#!/usr/bin/env bash
# The original per-family proof planted "Senpi edition (beta)" everywhere, which trips RULE 1 only.
# Rule 2 ("every surviving mention is an allowlisted engine name") was therefore never exercised in
# any family - which is exactly how a family exemption and an over-broad allowlist entry both
# survived review. This plants a RULE-2-ONLY phrase per family: the engine offered as a product to
# adopt, which no allowlist entry may excuse.
set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../../.." || exit 1
GUARD="packages/omo-opencode/src/cli/native-wording-guard.test.ts"
PHRASE="Choose Senpi today."

declare -a TARGETS=(
  "docs/reference/known-issues.md|<!-- wording-guard-plant: ${PHRASE} -->"
  "docs/guide/orchestration.md|<!-- wording-guard-plant: ${PHRASE} -->"
  "docs/legal/privacy-policy.md|<!-- wording-guard-plant: ${PHRASE} -->"
  "packages/omo-native/bin/lib/setup-report.js|// wording-guard-plant: ${PHRASE}"
  "packages/omo-senpi/src/components/onboarding/component.ts|// wording-guard-plant: ${PHRASE}"
)

fail=0
for entry in "${TARGETS[@]}"; do
  file="${entry%%|*}"
  plant="${entry#*|}"
  [ -f "$file" ] || { echo "SKIP (absent): $file"; continue; }

  cp "$file" "/tmp/$(basename "$file").rule2bak"
  printf '\n%s\n' "$plant" >> "$file"

  out="$(bun test "$GUARD" 2>&1)"
  caught=0
  printf '%s' "$out" | grep -q "$file" && caught=1

  cp "/tmp/$(basename "$file").rule2bak" "$file"
  rm -f "/tmp/$(basename "$file").rule2bak"

  echo
  echo "======== RULE-2 FAMILY CHECK: $file ========"
  echo "plant: $plant"
  if [ "$caught" = "1" ]; then
    echo "result: CAUGHT by rule 2"
    printf '%s' "$out" | grep -E "^\+ +\"$file" | head -1
  else
    echo "result: NOT CAUGHT - rule 2 does not cover this family"
    fail=1
  fi
done

echo
if [ "$fail" = "0" ]; then
  echo "PASS: every family reports a rule-2-only violation"
else
  echo "FAIL: at least one family is scanned but not rule-2 covered"
fi
echo "tree dirty after restore: $(git status --short | wc -l | tr -d ' ')"
exit "$fail"

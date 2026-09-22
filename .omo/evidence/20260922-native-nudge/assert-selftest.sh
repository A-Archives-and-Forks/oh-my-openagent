#!/usr/bin/env bash
# Proves the live-capture assertions are NOT vacuous by driving them against
# three synthetic event streams. The original anchored grep matched nothing and
# made every downstream check pass regardless of input; these cases fail if that
# regression ever returns.
set -uo pipefail
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

check() {
  local events="$1" frame="$TMP/frame.json"
  grep '"type":"session.created"' "$events" | head -1 > "$frame"
  if [ ! -s "$frame" ]; then echo "FAIL-BRANCH"; return; fi
  if grep -q '"parentID"' "$frame"; then echo "CHILD-BRANCH"; else echo "TOPLEVEL-BRANCH"; fi
}

printf '%s\n' 'data: {"properties":{"info":{"id":"ses_x"}},"type":"session.created"}' > "$TMP/a"
printf '%s\n' 'data: {"properties":{"info":{"id":"ses_y","parentID":"ses_x"}},"type":"session.created"}' > "$TMP/b"
printf '%s\n' 'data: {"type":"server.connected"}' > "$TMP/c"

a="$(check "$TMP/a")"; b="$(check "$TMP/b")"; c="$(check "$TMP/c")"
echo "type-last key order, no parentID -> $a   (expected TOPLEVEL-BRANCH)"
echo "type-last key order, parentID    -> $b   (expected CHILD-BRANCH)"
echo "no session.created at all        -> $c   (expected FAIL-BRANCH)"
[ "$a" = "TOPLEVEL-BRANCH" ] && [ "$b" = "CHILD-BRANCH" ] && [ "$c" = "FAIL-BRANCH" ] \
  && echo "PASS: all three branches are reachable, so the assertions can fail" \
  || { echo "FAIL: an assertion is vacuous"; exit 1; }

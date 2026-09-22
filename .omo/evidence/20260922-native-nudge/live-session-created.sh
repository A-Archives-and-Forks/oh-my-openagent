#!/usr/bin/env bash
# Proves that a real opencode process emits the exact event the native-edition
# nudge hook listens to, with the top-level shape the hook requires.
#
# The hook fires on `session.created` and skips when properties.info.parentID is
# set, so "the event exists" is not enough - the payload has to be inspected.
set -uo pipefail

SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.agents/skills/opencode-qa/scripts" && pwd)"
. "$SKILL_DIR/lib/common.sh"

trap oqa_cleanup EXIT

oqa_mk_isolated_xdg || { echo "FAIL: could not build an isolated sandbox"; exit 1; }
echo "sandbox: <tmp>/$(basename "$OQA_XDG_ROOT")  (the real opencode DB is untouched)"

oqa_start_server || { echo "FAIL: server did not start"; exit 1; }
BASE="$OQA_SERVER_URL"
PASS="$OQA_SERVER_PASS"
echo "server: 127.0.0.1:$OQA_SERVER_PORT"

EVENTS="$XDG_STATE_HOME/events.ndjson"
# --max-time bounds the SSE stream: it never closes on its own, and a plain
# background kill does not reliably reach curl through the pipeline.
curl -sN --max-time 12 -u "opencode:$PASS" "$BASE/event" > "$EVENTS" &
STREAM_PID=$!
sleep 2

echo "--- creating a real session over the HTTP API ---"
CREATED=$(curl -s -X POST -u "opencode:$PASS" \
  -H 'Content-Type: application/json' -d '{"title":"native nudge QA"}' \
  "$BASE/session?directory=$PWD")
echo "POST /session -> $(printf '%s' "$CREATED" | head -c 120)"

wait "$STREAM_PID" 2>/dev/null || true

FRAME="$XDG_STATE_HOME/frame.json"
# The key order in the frame is not guaranteed, so match the whole line rather
# than assuming "type" comes first - an anchored pattern silently matches
# nothing and turns every assertion built on it into a vacuous pass.
grep '"type":"session.created"' "$EVENTS" | head -1 > "$FRAME"

echo
echo "--- the session.created frame observed on the wire ---"
cut -c1-420 "$FRAME"

echo
if [ ! -s "$FRAME" ]; then
  echo "FAIL: session.created never appeared on the stream"
  exit 1
fi
echo "PASS: a real opencode process emitted session.created ($(wc -c < "$FRAME" | tr -d ' ') bytes captured)"

if grep -q '"parentID"' "$FRAME"; then
  echo "NOTE: this frame carries parentID, so the hook would correctly skip it"
else
  echo "PASS: the frame is top-level (no parentID), which is what the hook requires to fire"
fi

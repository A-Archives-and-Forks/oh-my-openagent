#!/usr/bin/env bash
# Real-surface QA for omo #8618 (OmO Native wording + --platform=native).
# Everything runs in an isolated HOME/XDG sandbox with fake package managers on
# PATH, so no global install and no real ~ state is ever touched.
set -uo pipefail

REPO="$(cd "$(dirname "$0")/../../.." && pwd)"
EV="$REPO/.omo/evidence/20260922-native-wording"
BUN_REAL="$(command -v bun)"
NODE_REAL="$(command -v node)"
SANDBOX="$(mktemp -d "${TMPDIR:-/tmp}/omo8618-qa.XXXXXX")"
CLI="$REPO/packages/omo-opencode/src/cli/index.ts"

mkdir -p "$SANDBOX/home" "$SANDBOX/xdg-data" "$SANDBOX/xdg-config" "$SANDBOX/xdg-state" "$SANDBOX/xdg-cache" "$SANDBOX/fakebin"

for pm in bun npm; do
  cat > "$SANDBOX/fakebin/$pm" <<EOF
#!/usr/bin/env bash
echo "FAKE-$pm ARGV: \$*"
exit \${FAKE_PM_EXIT:-0}
EOF
  chmod +x "$SANDBOX/fakebin/$pm"
done

sandbox_env() {
  env -i \
    HOME="$SANDBOX/home" \
    TMPDIR="$SANDBOX" \
    XDG_DATA_HOME="$SANDBOX/xdg-data" \
    XDG_CONFIG_HOME="$SANDBOX/xdg-config" \
    XDG_STATE_HOME="$SANDBOX/xdg-state" \
    XDG_CACHE_HOME="$SANDBOX/xdg-cache" \
    OMO_SEND_ANONYMOUS_TELEMETRY=0 \
    OMO_DISABLE_POSTHOG=1 \
    "$@"
}

echo "sandbox: $SANDBOX"
echo "repo:    $REPO"
echo

echo "### (a) --no-tui installer for the OpenCode edition: the printed hint"
sandbox_env PATH="/usr/bin:/bin:/usr/sbin:/sbin" "$BUN_REAL" "$CLI" install --no-tui --platform=opencode \
  --claude=no --gemini=no --copilot=no --skip-auth \
  > "$EV/qa-a-installer-hint.txt" 2>&1
echo "exit=$?"
grep -nE 'OmO Native|Senpi|omo-ai@beta|installation.md#' "$EV/qa-a-installer-hint.txt" || true
echo

echo "### (b) node postinstall.mjs: the package notice"
( cd "$REPO" && sandbox_env PATH="/usr/bin:/bin" "$NODE_REAL" postinstall.mjs ) \
  > "$EV/qa-b-postinstall.txt" 2>&1
echo "exit=$?"
grep -nE 'OmO Native|Senpi' "$EV/qa-b-postinstall.txt" || true
echo

echo "### (c) install --help lists native"
sandbox_env PATH="/usr/bin:/bin" "$BUN_REAL" "$CLI" install --help \
  > "$EV/qa-c-install-help.txt" 2>&1
echo "exit=$?"
grep -nE -- '--platform' "$EV/qa-c-install-help.txt" || true
echo

echo "### (d) --platform=native with bun on PATH (fake bun captures the argv)"
sandbox_env PATH="$SANDBOX/fakebin:/usr/bin:/bin" "$BUN_REAL" "$CLI" install --no-tui --platform=native \
  > "$EV/qa-d-platform-native-bun.txt" 2>&1
echo "exit=$?"
cat "$EV/qa-d-platform-native-bun.txt"
echo

echo "### (e) --platform=native with no bun on PATH (npm fallback)"
mkdir -p "$SANDBOX/npmonly" && cp "$SANDBOX/fakebin/npm" "$SANDBOX/npmonly/npm"
sandbox_env PATH="$SANDBOX/npmonly:/usr/bin:/bin" "$BUN_REAL" "$CLI" install --no-tui --platform=native \
  > "$EV/qa-e-platform-native-npm.txt" 2>&1
echo "exit=$?"
cat "$EV/qa-e-platform-native-npm.txt"
echo

echo "### (f) --platform=native when the package manager fails (exit 7)"
sandbox_env PATH="$SANDBOX/fakebin:/usr/bin:/bin" FAKE_PM_EXIT=7 "$BUN_REAL" "$CLI" install --no-tui --platform=native \
  > "$EV/qa-f-platform-native-failure.txt" 2>&1
echo "exit=$?"
cat "$EV/qa-f-platform-native-failure.txt"
echo

echo "### (g) --platform=native-dev is refused without the env flag"
sandbox_env PATH="/usr/bin:/bin" "$BUN_REAL" "$CLI" install --no-tui --platform=native-dev \
  > "$EV/qa-g-native-dev-refused.txt" 2>&1
echo "exit=$?"
cat "$EV/qa-g-native-dev-refused.txt"
echo

echo "### VERDICT: banned wording across every captured surface"
if grep -rniE 'senpi[ -]*(native[ -]*)?edition|standalone senpi' "$EV"/qa-*.txt; then
  echo "VERDICT=FAIL (banned edition wording found)"
else
  echo "VERDICT=PASS (no banned edition wording in any captured surface)"
fi
echo "OmO Native mentions: $(grep -roc 'OmO Native' "$EV"/qa-*.txt | tr '\n' ' ')"
echo

echo "### isolation + cleanup"
echo "real HOME untouched (sandbox HOME was $SANDBOX/home):"
ls -la "$SANDBOX/home" 2>/dev/null | head -20
rm -rf "$SANDBOX"
echo "cleanup: rm -rf $SANDBOX -> $([ -d "$SANDBOX" ] && echo STILL_PRESENT || echo REMOVED)"

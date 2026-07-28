#!/usr/bin/env bash
# Live-surface driver for issue #6376.
#
# The bug only manifests in the BUILT CLI bundle: bundlers inline
# packages/shared-skills/index.mjs, so `import.meta.url` becomes the consuming
# bundle's own URL. dist/index.js sits beside dist/skills and resolves correctly,
# but dist/cli/index.js and dist/cli-node/index.js sit one level below it.
#
# This drives the real built output:
#   1. asset asymmetry           - dist/skills has the asset, dist/cli/skills does not
#   2. inlined literals          - what the shipped bundle actually contains
#   3. resolution at the real location - a probe copy of the SHIPPED index.mjs placed in
#      the exact directory each bundle lives in, so its import.meta.url reproduces the
#      bundle's own resolution against the real built assets
#   4. real omo CLI doctor       - corroborating user-facing surface
#
# Everything runs against an isolated sandbox HOME so the real host state is untouched.
#
# usage: bash live-driver.sh <output-file>
set -uo pipefail

OUT="${1:?usage: live-driver.sh <output-file>}"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SBX="$(mktemp -d "${TMPDIR:-/tmp}/omo-6376-XXXXXX")"
trap 'rm -rf "$SBX"; rm -f "$REPO/dist/cli/omo-6376-probe.mjs" "$REPO/dist/cli-node/omo-6376-probe.mjs" "$REPO/dist/omo-6376-probe.mjs"' EXIT

export HOME="$SBX/home"
export USERPROFILE="$SBX/home"
export APPDATA="$SBX/home/AppData/Roaming"
export LOCALAPPDATA="$SBX/home/AppData/Local"
export XDG_DATA_HOME="$SBX/home/.local/share"
export XDG_CONFIG_HOME="$SBX/home/.config"
export XDG_STATE_HOME="$SBX/home/.local/state"
export XDG_CACHE_HOME="$SBX/home/.cache"
export OPENCODE_DISABLE_AUTOUPDATE=1
export OPENCODE_DISABLE_MODELS_FETCH=1
mkdir -p "$APPDATA" "$LOCALAPPDATA" "$XDG_DATA_HOME" "$XDG_CONFIG_HOME" "$XDG_STATE_HOME" "$XDG_CACHE_HOME"

{
  echo "### live-surface capture for issue #6376"
  echo "### surface: the BUILT omo CLI bundles under dist/"
  echo "### index.mjs diff vs upstream/dev at capture time:"
  git -C "$REPO" diff --stat upstream/dev -- packages/shared-skills/index.mjs
  echo "### (empty above == unmodified base; non-empty == fix applied)"
  echo
  echo "=== 1. asset asymmetry (the precondition of the bug) ==="
  echo "  dist/skills/ast-grep/install.sh          : $([ -f "$REPO/dist/skills/ast-grep/install.sh" ] && echo EXISTS || echo MISSING)"
  echo "  dist/cli/skills/ast-grep/install.sh      : $([ -f "$REPO/dist/cli/skills/ast-grep/install.sh" ] && echo EXISTS || echo MISSING)"
  echo "  dist/cli-node/skills/ast-grep/install.sh : $([ -f "$REPO/dist/cli-node/skills/ast-grep/install.sh" ] && echo EXISTS || echo MISSING)"
  echo
  echo "=== 2. literals inlined into the SHIPPED bundles ==="
  for B in dist/index.js dist/cli/index.js dist/cli-node/index.js; do
    [ -f "$REPO/$B" ] || { echo "  $B : (absent)"; continue; }
    printf '  %-24s sibling "./skills/"=%s  parent "../skills/"=%s\n' "$B" \
      "$(grep -c 'new URL("\./skills/"' "$REPO/$B" 2>/dev/null)" \
      "$(grep -c 'new URL("\.\./skills/"' "$REPO/$B" 2>/dev/null)"
  done
  echo
  echo "=== 3. resolution AT each real bundle location ==="
} > "$OUT"

for D in dist dist/cli dist/cli-node; do
  [ -d "$REPO/$D" ] || continue
  cp "$REPO/packages/shared-skills/index.mjs" "$REPO/$D/omo-6376-probe.mjs"
  ( cd "$REPO" && node -e '
    const { pathToFileURL } = require("node:url");
    const { existsSync } = require("node:fs");
    const { join } = require("node:path");
    const dir = process.argv[1];
    import(pathToFileURL(join(dir, "omo-6376-probe.mjs")).href).then((m) => {
      const p = m.sharedSkillsRootPath();
      const asset = join(p, "ast-grep", "install.sh");
      console.log("  bundle dir " + dir.padEnd(14) + " -> " + p);
      console.log("      dir exists            : " + existsSync(p));
      console.log("      ast-grep/install.sh   : " + (existsSync(asset) ? "FOUND" : "MISSING"));
    });
  ' "$D" ) >> "$OUT" 2>&1
  rm -f "$REPO/$D/omo-6376-probe.mjs"
done

{
  echo
  echo "=== 4. real omo CLI in the isolated sandbox ==="
  echo "\$ node dist/cli-node/index.js doctor"
} >> "$OUT"
( cd "$SBX" && node "$REPO/dist/cli-node/index.js" doctor ) >> "$OUT" 2>&1
echo "EXIT=$?" >> "$OUT"

echo "wrote $OUT"

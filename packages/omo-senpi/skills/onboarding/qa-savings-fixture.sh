#!/usr/bin/env bash
set -euo pipefail

TMPDIR_QA=$(mktemp -d)
trap 'rm -rf "$TMPDIR_QA"' EXIT

cat > "$TMPDIR_QA/s1.jsonl" <<'EOF'
{"type":"session","id":"s1","timestamp":"2026-07-01T00:00:00Z"}
{"type":"model_change","modelId":"model-a","timestamp":"not-a-date"}
{"type":"message","timestamp":"garbage","message":{"role":"assistant","usage":{"input":1000,"output":200,"cacheRead":4000,"cacheWrite":500}}}
{"type":"model_change","modelId":"model-b"}
{"type":"message","message":{"role":"assistant","usage":{"input":0,"output":100,"cacheRead":0,"cacheWrite":0}}}
EOF

cat > "$TMPDIR_QA/s2.jsonl" <<'EOF'
{"type":"session","id":"s2","timestamp":"2026-07-02T00:00:00Z"}
{"type":"model_change","modelId":"model-c","timestamp":"2026-07-02T00:00:01Z"}
{"type":"message","message":{"role":"assistant","usage":{"input":300,"output":50,"cacheRead":700,"cacheWrite":0}}}
EOF

ACTUAL=$(node - "$TMPDIR_QA/s1.jsonl" "$TMPDIR_QA/s2.jsonl" <<'EOF'
const fs = require("fs");
const prices = {
  "model-a": { input: 3e-6, cacheRead: 0.3e-6, output: 15e-6 },
  "model-b": { input: 1e-6, cacheRead: 0.1e-6, output: 5e-6 },
};
const totals = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
const perModel = {};
for (const file of process.argv.slice(2)) {
  let model = null;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const ev = JSON.parse(line);
    if (ev.type === "model_change") { model = ev.modelId; continue; }
    if (ev.type !== "message") continue;
    const u = ev.message && ev.message.usage;
    if (!u || model === null) continue;
    const m = perModel[model] ||= { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
    for (const k of ["input", "cacheRead", "cacheWrite", "output"]) {
      totals[k] += u[k] || 0;
      m[k] += u[k] || 0;
    }
  }
}
let actual = 0, baseline = 0, unpricedTokens = 0;
const modelRates = {};
for (const [model, m] of Object.entries(perModel)) {
  const denom = m.input + m.cacheRead;
  modelRates[model] = denom === 0 ? "0.000" : (m.cacheRead / denom).toFixed(3);
  const p = prices[model];
  if (!p) { unpricedTokens += m.input + m.cacheRead + m.cacheWrite + m.output; continue; }
  actual += m.input * p.input + m.cacheRead * p.cacheRead + m.output * p.output;
  baseline += (m.input + m.cacheRead) * p.input + m.output * p.output;
}
const denom = totals.input + totals.cacheRead;
process.stdout.write(JSON.stringify({
  input: totals.input,
  cacheRead: totals.cacheRead,
  cacheWrite: totals.cacheWrite,
  output: totals.output,
  cacheRate: denom === 0 ? "0.000" : (totals.cacheRead / denom).toFixed(3),
  modelBRate: modelRates["model-b"],
  actual: actual.toFixed(4),
  baseline: baseline.toFixed(4),
  savings: (baseline - actual).toFixed(4),
  unpricedTokens,
}));
EOF
)

EXPECTED='{"input":1300,"cacheRead":4700,"cacheWrite":500,"output":350,"cacheRate":"0.783","modelBRate":"0.000","actual":"0.0077","baseline":"0.0185","savings":"0.0108","unpricedTokens":1050}'

test "$ACTUAL" = "$EXPECTED"
echo "qa-savings-fixture: OK"

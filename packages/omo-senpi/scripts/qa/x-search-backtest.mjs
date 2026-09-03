#!/usr/bin/env bun
import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import {
  extractTweetIds, jaccard, recall, aggregate, fixtureKey, costGuard,
  reconcileCost, redactSecrets, webOverlap, validateQuerySet, materializeDates,
  PER_CALL_CEILING_USD,
} from "./x-search-backtest-core.mjs";
import {
  X_SEARCH_ENDPOINT, CARRIER_MODELS, buildXSearchRequest, performXSearch,
} from "../../src/components/x-search/client.ts";
if (process.env.OMO_X_SEARCH_BACKTEST_NO_NETWORK === "1") {
  globalThis.fetch = () => { throw new Error("OMO_X_SEARCH_BACKTEST_NO_NETWORK: network disabled"); };
}

const DEFAULT_RUN_DATE = "2026-09-03";
const LANES = ["grok-cli", "api-direct", "omo-tool", "web"];
const VARIANTS = ["v1", "v2"];
const CARRIERS = ["fast", "reasoning"];

function parseArgs(argv) {
  const out = { mode: "record", variants: VARIANTS, carriers: CARRIERS, withGrokCli: false, report: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--with-grok-cli") out.withGrokCli = true;
    else if (arg === "--report") out.report = true;
    else if (arg.startsWith("--")) {
      const key = arg.slice(2).replaceAll("-", "");
      const value = argv[++i];
      if (key === "queries") out.queries = value;
      else if (key === "mode") out.mode = value;
      else if (key === "variants") out.variants = value.split(",").filter(Boolean);
      else if (key === "carriers") out.carriers = value.split(",").filter(Boolean);
      else if (key === "capusd") out.capUsd = Number(value);
      else if (key === "out") out.out = value;
      else throw new Error(`unknown flag ${arg}`);
    } else throw new Error(`unexpected argument ${arg}`);
  }
  if (!out.queries || !out.out || !["record", "offline"].includes(out.mode)) throw new Error("--queries, --mode record|offline, and --out are required");
  if (!out.variants.every((v) => VARIANTS.includes(v)) || !out.carriers.every((c) => CARRIERS.includes(c))) throw new Error("invalid variants or carriers");
  return out;
}

function paramsFor(query, runDate) {
  const dates = materializeDates(query, runDate);
  return { query: query.query, mode: "latest", max_results: 10, from_date: dates.since, to_date: dates.to_date, ...(query.x_search ?? {}) };
}
function requestFor(query, variant, carrier, runDate) {
  return buildXSearchRequest(paramsFor(query, runDate), { variant, carrier: CARRIER_MODELS[carrier] });
}
function keyFor(query, lane, variant, carrier, request) {
  return fixtureKey({ queryId: query.id, lane, variant, carrier, request });
}
function emptyMetrics() { return { jaccard: null, recall: null, x_search_calls: null }; }
function normalizeIds(value) { return extractTweetIds(value); }
function laneResult(value, referenceIds, status) {
  const ids = status === "ok" ? normalizeIds(value) : [];
  return { status, ids, ...status === "ok" ? { jaccard: jaccard(ids, referenceIds), recall: recall(ids, referenceIds), x_search_calls: value?.usage?.server_side_tool_usage_details?.x_search_calls ?? value?.usage?.xSearchCalls ?? null } : emptyMetrics() };
}

async function loadFixture(fixturesDir, query, lane, variant, carrier, request) {
  const path = join(fixturesDir, `${keyFor(query, lane, variant, carrier, request)}.json`);
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  // Accept hand-authored fixtures that omit the internal key metadata.
  for (const name of await readdir(fixturesDir)) {
    if (!name.endsWith(".json")) continue;
    const candidate = JSON.parse(await readFile(join(fixturesDir, name), "utf8"));
    if (candidate.lane !== lane || candidate.queryId !== query.id) continue;
    if (candidate.status === "blocked_auth" && lane === "grok-cli") return candidate;
    if (candidate.request && JSON.stringify(candidate.request) === JSON.stringify(request) && candidate.status) return candidate;
  }
  return null;
}

async function runGrok(query, variant, carrier, runDate) {
  if (process.env.OMO_X_SEARCH_BACKTEST_NO_NETWORK === "1") throw new Error("OMO_X_SEARCH_BACKTEST_NO_NETWORK: network disabled");
  const prompt = requestFor(query, variant, carrier, runDate).input[0].content;
  const args = ["--no-auto-update", "-p", prompt, "--output-format", "json", "--disable-web-search", "--max-turns", "1", "--always-approve", "--no-memory", "--no-subagents"];
  return new Promise((resolveResult) => {
    const child = spawn("/Users/yeongyu/.grok/bin/grok", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "", settled = false;
    const finish = (value) => { if (!settled) { settled = true; resolveResult(value); } };
    child.stdout.on("data", (x) => { stdout += x; }); child.stderr.on("data", (x) => { stderr += x; });
    const timer = setTimeout(() => { child.kill("SIGKILL"); finish({ status: "error", errors: ["grok CLI timed out after 120s"] }); }, 120000);
    child.on("close", (code) => { clearTimeout(timer); const blocked = /Sign in|Open this URL/i.test(stderr); finish({ status: blocked ? "blocked_auth" : code === 0 ? "ok" : "error", stdout: stdout.trim(), errors: stderr ? [stderr.trim()] : [] }); });
  });
}

async function runApi(request, bearer) {
  const result = await performXSearch({ fetch, bearer, body: request, endpoint: X_SEARCH_ENDPOINT, deadlineMs: 120000 });
  if (result.ok) return { status: "ok", response: result.raw, errors: [] };
  return { status: result.code === "AUTH" ? "blocked_auth" : "error", errors: [result.message] };
}
async function runWeb(query, bearer) {
  const body = { model: CARRIER_MODELS.fast.model, input: [{ role: "user", content: `Search the web for: ${query.query}` }], tools: [{ type: "web_search" }], tool_choice: "required", max_turns: 1, parallel_tool_calls: false, max_output_tokens: 4000, store: false };
  const result = await performXSearch({ fetch, bearer, body, endpoint: X_SEARCH_ENDPOINT, deadlineMs: 120000 });
  if (result.ok) return { status: "ok", response: result.raw, errors: [] };
  return { status: result.code === "AUTH" ? "blocked_auth" : "error", errors: [result.message] };
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const querySet = JSON.parse(await readFile(resolve(options.queries), "utf8"));
  if (!validateQuerySet(querySet)) throw new Error("invalid query set");
  const runDate = process.env.X_SEARCH_RUN_DATE ?? DEFAULT_RUN_DATE;
  const outDir = resolve(options.out); const fixturesDir = join(outDir, "fixtures");
  await mkdir(fixturesDir, { recursive: true });
  const capUsd = options.capUsd ?? querySet.cap_usd ?? Infinity;
  let state = { spentUsd: 0, reservedUsd: 0, capUsd, status: "ok" };
  const reports = [];
  for (const query of querySet.queries) {
    const referenceIds = extractTweetIds(query.reference_urls ?? []);
    const lanes = {};
    for (const variant of options.variants) for (const carrier of options.carriers) {
      const request = requestFor(query, variant, carrier, runDate);
      for (const lane of LANES) {
        const includeLiveGrok = options.withGrokCli && options.mode === "record";
        if (lane === "grok-cli" && !includeLiveGrok && options.mode === "record") continue;
        let raw = await loadFixture(fixturesDir, query, lane, variant, carrier, request);
        if (options.mode === "offline") {
          if (!raw) lanes[`${lane}:${variant}:${carrier}`] = { status: "missing_fixture", ...emptyMetrics() };
          else {
            const value = laneResult(raw.response ?? raw.stdout ?? raw, referenceIds, raw.status ?? "ok");
            if (lane === "web" && value.status === "ok" && typeof (raw.response ?? raw).text === "string") value.jaccard = webOverlap((raw.response ?? raw).text, query.web_terms);
            lanes[`${lane}:${variant}:${carrier}`] = value;
          }
          continue;
        }
        if (!raw) {
          const guard = costGuard(state);
          if (!guard.canSchedule) { lanes[`${lane}:${variant}:${carrier}`] = { status: "skipped_cost_cap", ...emptyMetrics() }; continue; }
          state.reservedUsd += PER_CALL_CEILING_USD;
          const bearer = process.env.XAI_API_KEY;
          let executed;
          if (process.env.OMO_X_SEARCH_BACKTEST_NO_NETWORK === "1") throw new Error("OMO_X_SEARCH_BACKTEST_NO_NETWORK: network disabled");
          if (lane === "grok-cli") executed = await runGrok(query, variant, carrier, runDate);
          else if (!bearer) executed = { status: "error", errors: ["missing XAI_API_KEY"] };
          else if (lane === "web") executed = await runWeb(query, bearer);
          else executed = await runApi(request, bearer);
          const usage = executed.response?.usage;
          state = reconcileCost({ ...state, reservedUsd: Math.max(0, state.reservedUsd - PER_CALL_CEILING_USD) }, usage?.cost_in_usd_ticks);
          raw = { request, ...executed, usage: usage ?? {}, recordedAt: new Date().toISOString() };
          await writeFile(join(fixturesDir, `${keyFor(query, lane, variant, carrier, request)}.json`), JSON.stringify(redactSecrets(raw, bearer), null, 2));
        }
        lanes[`${lane}:${variant}:${carrier}`] = laneResult(raw.response ?? raw.stdout ?? raw, referenceIds, raw.status ?? "ok");
      }
    }
    reports.push({ id: query.id, split: query.split, reference: referenceIds, lanes });
  }
  const chosen = choose(options, reports);
  const scored = reports.map((report) => {
    const lanes = Object.fromEntries(Object.entries(report.lanes).map(([id, value]) => [id, value]));
    for (const lane of LANES) lanes[lane] = lanes[`${lane}:${chosen.variant}:${chosen.carrier}`] ?? { status: "missing_fixture", ...emptyMetrics() };
    return { ...report, chosen: `${chosen.variant}:${chosen.carrier}`, lanes };
  });
  const report = { run: { status: state.status, mode: options.mode, runDate, queries: querySet.queries.length }, tuning: { chosen, calibration: scoreSplit(reports, "calibration", chosen) }, cost: { cap_usd: capUsd, spent_usd: state.spentUsd, within_cap: state.status !== "cap_exceeded" && state.spentUsd <= capUsd }, queries: scored, aggregate: aggregates(scored) };
  await mkdir(outDir, { recursive: true }); await writeFile(join(outDir, "report.json"), JSON.stringify(redactSecrets(report, process.env.XAI_API_KEY), null, 2));
  if (options.report) await writeFile(join(outDir, "report.md"), markdown(report));
  if (state.status === "cap_exceeded") process.exitCode = 4;
}

function scoreSplit(reports, split, chosen) {
  const vals = reports.filter((r) => r.split === split).map((r) => r.lanes[`omo-tool:${chosen.variant}:${chosen.carrier}`]?.jaccard).filter((v) => typeof v === "number");
  return { jaccard: aggregate(vals) };
}
function choose(options, reports) {
  const candidates = [];
  for (const variant of options.variants) for (const carrier of options.carriers) {
    const rows = reports.filter((r) => r.split === "calibration");
    const pairs = rows.map((r) => { const tool = r.lanes[`omo-tool:${variant}:${carrier}`]; const ref = r.lanes[`grok-cli:${variant}:${carrier}`]?.status === "ok" ? r.lanes[`grok-cli:${variant}:${carrier}`] : r.lanes[`api-direct:${variant}:${carrier}`]; return { j: tool?.jaccard, r: tool?.recall, calls: tool?.x_search_calls ?? Infinity, ref }; }).filter((x) => typeof x.j === "number");
    candidates.push({ variant, carrier, meanJaccard: aggregate(pairs.map((x) => x.j)).mean ?? -1, meanRecall: aggregate(pairs.map((x) => x.r)).mean ?? -1, x_search_calls: aggregate(pairs.map((x) => x.calls)).mean ?? Infinity });
  }
  return candidates.sort((a, b) => b.meanJaccard - a.meanJaccard || b.meanRecall - a.meanRecall || a.x_search_calls - b.x_search_calls || `${a.variant}:${a.carrier}`.localeCompare(`${b.variant}:${b.carrier}`))[0] ?? { variant: options.variants[0], carrier: options.carriers[0] };
}
function aggregates(reports) {
  const result = { lanes: {}, calibration: {}, holdout: {} };
  for (const lane of LANES) { const rows = reports.flatMap((r) => Object.entries(r.lanes).filter(([id]) => id.startsWith(`${lane}:`)).map(([, v]) => v)); result.lanes[lane] = { jaccard: aggregate(rows.map((v) => v.jaccard)), recall: aggregate(rows.map((v) => v.recall)) }; }
  for (const split of ["calibration", "holdout"]) { const rows = reports.filter((r) => r.split === split).flatMap((r) => Object.values(r.lanes)); result[split] = { jaccard: aggregate(rows.map((v) => v.jaccard)), recall: aggregate(rows.map((v) => v.recall)) }; }
  return result;
}
function markdown(report) { return `# X search backtest\n\nStatus: ${report.run.status}\n\nChosen variant: ${report.tuning.chosen.variant}, carrier: ${report.tuning.chosen.carrier}\n\n| Query | Lane | Status | Jaccard | Recall |\n|---|---|---|---:|---:|\n${report.queries.flatMap((q) => Object.entries(q.lanes).map(([lane, v]) => `| ${q.id} | ${lane} | ${v.status} | ${v.jaccard ?? "NA"} | ${v.recall ?? "NA"} |`)).join("\n")}\n`; }

if (import.meta.main) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
export { main, parseArgs };

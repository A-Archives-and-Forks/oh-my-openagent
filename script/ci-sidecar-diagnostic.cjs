// Temporary CI diagnostic (removed before merge): when the committed-bundle check fails on a runner,
// rebuild omo-task.js there and print how it diverges from the committed artifact.
const { spawnSync } = require("node:child_process")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const out = fs.mkdtempSync(path.join(os.tmpdir(), "omo-sidecar-diag-"))
const build = spawnSync("node", ["packages/omo-senpi/plugin/scripts/build-extension.mjs"], { env: { ...process.env, OMO_SENPI_PLUGIN_OUTPUT: out }, encoding: "utf8" })
console.log((build.stdout + build.stderr).split("\n").filter((l) => /Bundled 6/.test(l)).join("\n"))
const committed = fs.readFileSync("packages/omo-senpi/plugin/extensions/omo-task.js", "utf8")
const rebuilt = fs.readFileSync(path.join(out, "extensions", "omo-task.js"), "utf8")
const marker = (t) => (t.match(/\/\/ omo:[^\n]*/) ?? ["?"])[0]
const body = (t) => t.slice(t.indexOf("\n", t.indexOf("// omo:")) + 1)
console.log("committed:", marker(committed)); console.log("rebuilt:  ", marker(rebuilt))
const bc = body(committed).split(";"), br = body(rebuilt).split(";")
let i = 0; while (i < bc.length && i < br.length && bc[i] === br[i]) i += 1
console.log("bodyLen committed=" + body(committed).length + " rebuilt=" + body(rebuilt).length + " stmts=" + bc.length + "/" + br.length + " firstDivergent=" + i)
console.log("C:", (bc[i] ?? "").slice(0, 900)); console.log("R:", (br[i] ?? "").slice(0, 900))
const specs = (t) => new Set([...t.matchAll(/from"([^"]+)"|import\("([^"]+)"\)|require\("([^"]+)"\)/g)].map((m) => m[1] ?? m[2] ?? m[3]))
const sc = specs(body(committed)), sr = specs(body(rebuilt))
console.log("specifiers only in committed:", [...sc].filter((s) => !sr.has(s)).join(",") || "-")
console.log("specifiers only in rebuilt:  ", [...sr].filter((s) => !sc.has(s)).join(",") || "-")
// which helper did bun inject? look for names present in one body only
const idents = (t) => new Set(t.match(/\b__[A-Za-z]+\b/g) ?? [])
const ic = idents(body(committed)), ir = idents(body(rebuilt))
console.log("bun helpers only in committed:", [...ic].filter((s) => !ir.has(s)).join(",") || "-")
console.log("bun helpers only in rebuilt:  ", [...ir].filter((s) => !ic.has(s)).join(",") || "-")
console.log("node=" + process.version, "bun=" + spawnSync("bun", ["--revision"], { encoding: "utf8" }).stdout.trim(), "arch=" + os.arch(), "cwd=" + process.cwd())

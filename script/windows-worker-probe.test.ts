import { expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { senpiWorkerCompileArgs } from "./senpi-worker-compile"

test("#given embedded worker paths #when relocated #then report constructor discrimination", () => {
  const scratch = mkdtempSync(join(tmpdir(), "omo-worker-probe-"))
  try {
    const root = join(scratch, "source")
    const workerDir = join(root, "node_modules/@code-yeongyu/senpi/dist/modes/rpc")
    mkdirSync(workerDir, { recursive: true })
    writeFileSync(join(workerDir, "session-worker.js"), 'import { parentPort } from "node:worker_threads"; parentPort.postMessage(import.meta.url);')
    const entry = join(root, "entry.ts")
    writeFileSync(entry, `import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import { existsSync, readdirSync } from "node:fs";
const url = new URL(SENPI_RPC_SESSION_WORKER_ENTRY, import.meta.url);
const native = fileURLToPath(url);
console.log(JSON.stringify({main: import.meta.url, url: url.href, native, exists: existsSync(native), files: readdirSync(import.meta.dir, {recursive: true})}));
for (const [kind, path] of [["url", url], ["native", native], ["posix", native.replaceAll("\\\\", "/")], ["relative", SENPI_RPC_SESSION_WORKER_ENTRY]]) {
  try {
    const message = await new Promise((resolve, reject) => {
      const worker = new Worker(path);
      worker.once("error", reject);
      worker.once("message", async (value) => { await worker.terminate(); resolve(value); });
    });
    console.log(JSON.stringify({kind, message}));
  } catch(error) { console.log(JSON.stringify({kind, error: String(error)})); }
}`)
    const binary = join(scratch, process.platform === "win32" ? "probe.exe" : "probe")
    const built = spawnSync(process.execPath, ["build", "--compile", entry, ...senpiWorkerCompileArgs(root), "--outfile", binary], { cwd: root, encoding: "utf8", timeout: 30_000 })
    expect(built.status, built.stderr).toBe(0)
    const relocated = join(scratch, "relocated")
    mkdirSync(relocated)
    const moved = join(relocated, process.platform === "win32" ? "probe.exe" : "probe")
    renameSync(binary, moved)
    rmSync(root, { recursive: true })
    const result = spawnSync(moved, [], { cwd: relocated, encoding: "utf8", timeout: 10_000 })
    console.log(result.stdout, result.stderr)
    expect(result.status, result.stderr).toBe(0)
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}, 45_000)

import { test, expect, describe } from "bun:test";
import { spawn } from "node:child_process";
import { join } from "node:path";

const dir = import.meta.dir;
const client = join(dir, "dap.mjs");
const fixture = join(dir, "fixture-adapter.mjs");

test("treats Windows drive-letter paths as executable specs, not host-port specs", async () => {
  const { isTcpAdapterSpec } = await import("./dap.mjs");
  expect(isTcpAdapterSpec("C:\\workspace\\fixture-adapter.mjs")).toBe(false);
  expect(isTcpAdapterSpec("127.0.0.1:5678")).toBe(true);
});

function frame(message: unknown) {
  const body = Buffer.from(JSON.stringify(message));
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]);
}

describe("DAP framing", () => {
  test("parses multiple frames and frames split across chunks", async () => {
    const { DapFrameParser } = await import("./dap.mjs");
    const parser = new DapFrameParser();
    const first = frame({ type: "event", event: "one" });
    const second = frame({ type: "event", event: "two", body: { ok: true } });
    expect(parser.push(Buffer.concat([first, second]))).toEqual([{ type: "event", event: "one" }, { type: "event", event: "two", body: { ok: true } }]);
    const third = frame({ type: "response", seq: 3 });
    expect(parser.push(third.subarray(0, 9))).toEqual([]);
    expect(parser.push(third.subarray(9, 17))).toEqual([]);
    expect(parser.push(third.subarray(17))).toEqual([{ type: "response", seq: 3 }]);
  });
});

function session(...fixtureArgs: string[]) {
  const child = spawn("bun", [client], { cwd: dir, env: { ...process.env, DAP_TIMEOUT_MS: "300", ...(fixtureArgs.includes("--no-answer") ? { DAP_FIXTURE_NO_ANSWER: "1" } : {}) } });
  let output = "";
  child.stdout.on("data", data => { output += data.toString(); });
  const api = { child, get output() { return output; }, command(line: string) { child.stdin.write(`${line}\n`); } };
  api.command(`launch ${fixture} /tmp/program.py`);
  return api;
}
async function until(s: ReturnType<typeof session>, predicate: (out: string) => boolean) {
  const deadline = Date.now() + 3000;
  while (!predicate(s.output) && Date.now() < deadline) await Bun.sleep(10);
  expect(predicate(s.output)).toBe(true);
}

test("full session emits stop snapshot, stack and capped variables", async () => {
  const s = session();
  await until(s, out => out.includes("READY: launch"));
  s.command("break /tmp/program.py:12"); await until(s, out => out.includes("BREAK:"));
  s.command("continue"); await until(s, out => out.includes("STOP: stopped reason=breakpoint threadId=1 main at /tmp/program.py:12:3"));
  s.command("stack"); await until(s, out => out.includes("FRAME\t"));
  s.command("vars 7"); await until(s, out => out.includes("TRUNCATED: rows dropped=150"));
  expect((s.output.match(/^v\d+\t/gm) ?? []).length).toBe(100);
  s.command("terminate"); await until(s, out => out.includes("EXIT:"));
  s.command("quit");
});

test("byte cap reports dropped bytes", async () => {
  const s = session();
  await until(s, out => out.includes("READY: launch"));
  s.command("vars 8"); await until(s, out => out.includes("TRUNCATED: rows dropped=") && out.includes("bytes dropped="));
  s.command("quit");
});

test("unverified breakpoint and timeout are classified", async () => {
  const s = session();
  await until(s, out => out.includes("READY: launch"));
  s.command("break /tmp/unverified.py:9"); await until(s, out => out.includes("ERR: unverified-breakpoint"));
  const t = session("--no-answer");
  await until(t, out => out.includes("ERR: timeout"));
  s.command("quit"); t.command("quit");
});

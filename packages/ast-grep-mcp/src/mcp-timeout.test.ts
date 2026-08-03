import { describe, expect, it } from "bun:test";
import { PassThrough, Writable } from "node:stream";
import { runMcpStdioServer } from "./mcp";

describe("ast_grep MCP hung-call abort", () => {
  it("#given a hung tool call #when the parent process disappears #then the active sg call is aborted", async () => {
    // given: a stub executor that never settles until its abort signal fires
    const capture = captureStdout();
    const input = new PassThrough();
    const started = Promise.withResolvers<AbortSignal>();
    const aborted = Promise.withResolvers<string>();
    let parentAlive = true;

    const server = runMcpStdioServer(input, capture.stdout, {
      resolveSgPath: () => "/stub/sg",
      parentWatchdog: { parentPid: 4242, pollIntervalMs: 1, probeAlive: () => parentAlive },
      executors: {
        search: async (_input, _sgPath, signal) => {
          started.resolve(signal as AbortSignal);
          await new Promise<void>((resolve) => {
            signal?.addEventListener("abort", () => {
              aborted.resolve(String(signal.reason ?? "aborted"));
              resolve();
            });
          });
          return { schemaVersion: 1, ok: false, kind: "search", error: { code: "ABORTED", message: "aborted" } } as never;
        },
      },
    });

    // when: the call is in flight and the watchdog observes a dead parent
    input.write('{"jsonrpc":"2.0","id":"hang","method":"tools/call","params":{"name":"search","arguments":{"pattern":"foo($$$ARGS)","language":"typescript","paths":["src"]}}}\n');
    const signal = await started.promise;
    expect(signal.aborted).toBe(false);
    parentAlive = false;

    // then
    await aborted.promise;
    expect(signal.aborted).toBe(true);
    input.end();
    await server;
  });

  it("#given a completed call #when a later call starts #then it receives a fresh, unaborted signal", async () => {
    // given
    const capture = captureStdout();
    const input = new PassThrough();
    const signals: AbortSignal[] = [];

    const server = runMcpStdioServer(input, capture.stdout, {
      resolveSgPath: () => "/stub/sg",
      executors: {
        search: async (_input, _sgPath, signal) => {
          signals.push(signal as AbortSignal);
          return { schemaVersion: 1, ok: true, kind: "search" } as never;
        },
      },
    });

    // when
    input.write('{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"search","arguments":{"pattern":"foo($$$ARGS)","language":"typescript","paths":["src"]}}}\n');
    input.write('{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"search","arguments":{"pattern":"foo($$$ARGS)","language":"typescript","paths":["src"]}}}\n');
    input.end();
    await server;

    // then
    expect(signals).toHaveLength(2);
    expect(signals[0]).not.toBe(signals[1]);
    expect(signals.every((signal) => !signal.aborted)).toBe(true);
  });
});

function captureStdout(): { readonly stdout: Writable; readonly read: () => string } {
  let captured = "";
  const stdout = new Writable({
    write(chunk: unknown, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
      captured += chunk instanceof Buffer ? chunk.toString() : String(chunk);
      callback();
    },
  });
  return { stdout, read: () => captured };
}

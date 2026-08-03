#!/usr/bin/env node
import { stderr } from "node:process";

/**
 * Minimal stdio entry stub for the ast-grep MCP server.
 *
 * The full MCP server (mcp.ts) will be implemented in later todos.
 * Until then, running this CLI emits a structured JSON-RPC error to
 * stderr and exits with code 1 so that any accidental invocation
 * fails loudly rather than silently hanging on stdin.
 */
async function main(): Promise<void> {
  const error = JSON.stringify({
    jsonrpc: "2.0",
    error: {
      code: -32601,
      message: "ast-grep MCP server not implemented",
    },
    id: null,
  });
  stderr.write(`${error}\n`);
  process.exit(1);
}

main();

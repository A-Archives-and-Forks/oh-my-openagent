import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const serialization = 'return JSON.stringify(value.type === "message_update" ? toJsonEvent(value) : value);'
const guardedSerialization = `try {
                    ${serialization}
                } catch (error) {
                    if (!(error instanceof Error)) throw error;
                    queueMicrotask(() => { void shutdown(1); });
                    return JSON.stringify({
                        type: "response", command: "prompt", success: false,
                        errorCode: "invalid_stream_event", error: error.message,
                        sessionId: value.sessionId,
                    });
                }`

/** Keep serializer failures on the RPC wire instead of escaping the event flush. */
export function prepareRpcStreamErrors(senpiRoot) {
  const path = join(senpiRoot, "dist", "modes", "rpc", "rpc-mode.js")
  if (!existsSync(path)) return
  const source = readFileSync(path, "utf8")
  if (source.includes(guardedSerialization)) return
  if (!source.includes(serialization)) throw new Error("omo-ai: unsupported Senpi RPC stream serializer")
  writeFileSync(path, source.replace(serialization, guardedSerialization))
}

# Task 3b - correlate thread RPC responses by request id (pre-existing defect found in the blast radius)

## WHAT WAS TESTED
`packages/omo-senpi/src/components/thread/live-surface.ts` `request()`: the one-shot JSONL client that every ThreadHost method uses. Three new cases in `live-surface.test.ts` (`live thread request correlation`) drive it through the file's existing fake unix-socket server, extended with a `preamble` so the server writes other frames BEFORE the correlated response, exactly as the multi-session host does: (1) an `open_session` admission notice `{type:"queued", for_request:<id>, position, in_flight}`; (2) connection-wide broadcasts (`agent_start`, `session_opened`) plus a response for a DIFFERENT request id; (3) a failure response for a different request id.

## WHAT WAS OBSERVED
- RED (unchanged `request()`): all three fail for the defect's exact reason - `thread RPC request failed: {"type":"queued",...}`, `thread RPC request failed: {"type":"agent_start",...}`, and the pending call rejected on the foreign failure frame. 17 pass / 3 fail.
- Root cause: `request()` took the FIRST newline-terminated line as the response. The installed engine (2026.9.20, `RpcOpenQueuedEvent` in `dist/modes/rpc/rpc-types.d.ts`) documents that the `queued` notice deliberately carries `for_request` and NOT the response id precisely so a client that settles by response id never mistakes it for the reply. n3-tools' isolated real-host probe hit this on `openSession` (task-3.log:1168) and reported it rather than patching it.
- GREEN: `request()` now generates the id up front, splits every line, skips lines that are not objects or whose `id` differs, and settles only on the correlated frame; a connection closed before that frame is a named error. 20 pass / 0 fail in the file; full thread + policy suite 197 pass / 0 fail; tsgo exit 0.
- LIVE: a read-only `listSessions()` through the fixed client against the user's default shared host socket completed a real round-trip (the host had been restarted and held 0 sessions at that moment). Before the fix the same path failed on any host that emits a non-response line first.

## WHY IT IS ENOUGH
The fake server reproduces the wire order the real host uses; the three cases cover the three kinds of non-response lines (admission notice, broadcast, foreign response). The full suite proves no other ThreadHost method regressed. The live read-only probe proves the default socket path end to end without mutating any session.

## WHAT WAS OMITTED
No senpi engine change; the engine's contract was already correct. No other file changed. The stale desktop override `OMO_RPC_SOCKET_PATH` pointing at a socket that no longer exists was observed in the lead's kernel environment and bypassed for the probe by pinning the agent dir; it is documented precedence, not a defect of this change.

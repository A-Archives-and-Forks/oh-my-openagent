# Kibitzer surface

This directory holds the read-only recall judge surface: the in-process decision engine that vets every tool call boundary against the lexical recall candidates and delivers nudges only through the `nudge` tool. Kibitzer is never an actor — it judges, and only nudges.

The sidecar **must remain read-only**. Every fire is a quick-pinned in-process child; the parent process owns all writes. File I/O inside this surface is for candidacy audit artifacts only (`candidates.json`, `transcript-window.txt`), never for mutable state.

## Anatomy

| Path | Purpose |
|------|---------|
| `delivery.ts` | Delivery lifecycle: marks nudges surfaced in the ledger, holds them in memory, writes the pending file (epoch-stamped), enqueues coordinator entries, and steers on the next `tool_result` when conditions permit. Compaction and shutdown drain the held nudges, clear coordinator entries, and delete the pending file. |
| `hooks.ts` | Event registration: binds to `tool_call` (trigger capture snapshot) and `tool_result` (delivery steer gate) with session-id resolution and context capture. |
| `judge-outcome.ts` | RunnerOutcome → judge classification: `completed` / `empty` / `failed` / `dropped`, mapping all terminal states through the settled outcome's disposition (child termination, model response, provider error, timeout). The model that answered after fallback rotation is recorded per run. |
| `nudge-tool.ts` | The judge's only action: `nudge` tool definition (ToolDefinition) with acceptance accounting (`maxItems` early-exit via `terminate: true` when all accepted) and path forwarding to the ledger. |
| `notice.ts` | Entry renderers and type constants: `GATE_ENTRY_TYPE` (judge result trace), `NUDGED_ENTRY_TYPE` (delivery result trace), gate reason normalization (bounded, sanitized, secrets redacted). |
| `task-runtime.ts` | Memoized task runtime loader (primed at registration, resolved per run, cached keyed by asset name). A throw is persona unavailable; import rejection is reported once as `omo-senpi memory boot asset unavailable`. |
| `composition.ts` (formerly `wiring-kibitzer.ts`) | Kibitzer composition: assembles `delivery`, `hooks`, and `trigger` (wired from parent) into the `KibitzerComposition` record that the parent's wiring injects. |
| `compat.test.ts` | Kibitzer recall compat: minimal smoke test of the nudge tool's type signature. |
| `delivery.test.ts` | Delivery state machine: acceptance → ledger mark + coordinator enqueue, tool_result steering gate, prompt drain, compaction, shutdown cleanup. |
| `delivery-idle.test.ts` | Delivery idle steer: verifies the delivery steerer skips nudges when the agent is idle (even if not pending). |
| `hooks.test.ts` | Hook registration smoke and session-id resolution. |
| `judge-outcome.test.ts` | Outcome classification: settled turn interpretation (responses, failures, timeouts), model recording, reason normalization. |
| `nudge-tool.test.ts` | Nudge tool: acceptance tracking, termination on maxItems, path forwarding. |
| `observability.test.ts` | Kibitzer observability: end-to-end trace rendering (entry types, nudged records, gate reason strings). |
| `task-runtime.test.ts` | Runtime loader: asset resolution, cache hits, persona-unavailable throws, import-rejection reporting. |

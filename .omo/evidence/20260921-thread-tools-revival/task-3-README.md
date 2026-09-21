## WHAT WAS TESTED

Task st_01a0c3b5 / task 3, in the supplied thread-tools-revival-20260921 worktree.

Plan recorded before editing:
- Extend tools.test.ts's in-memory host with five RPC methods, mutable sessions/model catalog, and assertions for rename, model resolution/error bounds, reasoning scope/rejection, invocation caller identity/self, fuzzy self exclusion, receipts, and workspace scope.
- Extend live-surface.test.ts with isolated Unix-socket JSONL request/response tests for all five RPCs and classified reasoning failures. Existing tests have no socket fixture, so introduce an event-driven local server; no fixed sleeps or polling.
- Capture both test files failing before implementation in task-3.log.
- Extend tools.ts's required ThreadHost surface, thread caller identity through the common executor/resolver/receipts, implement the three tools through that executor, and register them after handoff.
- Extend live-surface.ts with five RPCs, payload-less success handling, catalog projection, and narrowly classified unsupported-thinking errors.
- Update only name lists in component.test.ts and extension/thread-policy.test.ts.
- Run changed-file diagnostics, related tests, the requested complete thread/policy suite, package typecheck, and an in-memory build/manual real-surface exercise without writing generated files outside the allowed scope.

Scope-widening follow-up plan: the lead has now authorized all of component.test.ts. Extend its fake host with all five required methods, change the count to nine, preserve every case and the requested no-host-flag title, correct the remaining six-tool title, then run diagnostics plus both requested verification commands and record their outcomes.

Design decision: reuse the common receipt executor and pass per-invocation caller identity explicitly. Independent handlers or a mutable cached caller would duplicate failure/idempotency logic or mix sessions in a shared process. Model resolution prefers exact provider/id, then exact id, then case-insensitive id/display-name fragments, optionally restricted by provider. Session reasoning omits scope on the wire; turn reasoning sends scope: turn.

## WHAT WAS OBSERVED

Initial inspection found an authorization conflict: component.test.ts was restricted to name-list edits, while its required ThreadHost fixture lacked all five new methods and it separately asserted toHaveLength(6). This was reported before implementation. The lead subsequently widened that file's scope, authorizing and resolving both repairs. The final requested suite and package typecheck now pass.

Exact transcripts, command lines, exit codes, and the inline manual probe source are in `/Users/yeongyu/tmp/omo-wt/thread-tools-revival-20260921/.omo/evidence/20260921-thread-tools-revival/task-3.log`.

- RED: `bun test packages/omo-senpi/src/components/thread/tools.test.ts packages/omo-senpi/src/components/thread/live-surface.test.ts` exited 1 before implementation: 10 pass, 44 fail. Captured assertion text includes `thread_rename must be registered / Received: undefined`, the nine-name registration diff missing all three new names, and live-surface `Expected: "function" / Received: "undefined"`. Existing self resolution returned not_found, fuzzy handoff selected dur-self instead of dur-peer, and list host failures escaped as thrown errors.
- Focused GREEN: the same command exited 0 on its first post-implementation run: 54 pass, 0 fail, 165 assertions. This covers the requested RED cases plus all address-taking tools honoring self, caller-isolated receipt replay, rejection replay, same-name rename, whitespace rejection, conflict visibility, exact-id priority, and non-classified errors staying internal_error data.
- Complete requested suite, final GREEN: `bun test packages/omo-senpi/src/components/thread packages/omo-senpi/src/extension/thread-policy.test.ts` exited 0: 194 pass, 0 fail, 1,021 assertions across 13 files. The first run before scope widening exited 1 with 193 pass and the sole `Expected length: 6 / Received length: 9` failure. That failed transcript remains preserved; the final post-repair run passed without retries.
- Package typecheck, final GREEN: `./node_modules/.bin/tsgo --noEmit -p packages/omo-senpi/tsconfig.json` exited 0 with no output. The earlier TS2739 missing-methods fixture failure is preserved in the transcript and was resolved by the authorized five-method fixture extension.
- Changed-file LSP diagnostics: tools.ts, tools.test.ts, live-surface.ts, live-surface.test.ts, and extension/thread-policy.test.ts reported no diagnostics. Final component.test.ts diagnostics also report no diagnostics after its fixture repair.
- In-memory `Bun.build` of tools.ts and live-surface.ts with target node / packages external exited 0, produced two in-memory outputs (69,248 and 5,477 bytes), and reported no build logs. No generated files were written.
- `git diff --check` exited 0. Final status shows only the six authorized source/test files and these two evidence files changed; no git staging or commits occurred.
- An additional isolated real-host probe launched the installed Senpi CLI with `--mode rpc --multi-session --listen unix://<scratch>/rpc.sock --no-extensions --no-skills --no-prompt-templates --no-themes`. It exited 1 before reaching any new control: the unchanged openSession path rejected a host admission frame `{type:"queued", for_request:..., position:1, in_flight:0}` because the pre-existing one-shot request() reader treats the first JSONL line as the response. This separate pre-existing transport limitation was not patched. The child used a temporary HOME and temporary OMO/SENPI/PI_CODING_AGENT_DIR, a literal dummy key (no provider generation), and no inherited credentials. Cleanup awaited child termination (exit 143), then removed the scratch directory. This is a failed live probe, not a live-QA pass.

Confirmation rerun after the lead restated the four component.test.ts edits: all four were already applied and no further source change was needed. Both gates were re-executed to confirm the recorded end state. `bun test packages/omo-senpi/src/components/thread packages/omo-senpi/src/extension/thread-policy.test.ts` exited 0 again (194 pass, 0 fail, 1,021 assertions across 13 files) and `./node_modules/.bin/tsgo --noEmit -p packages/omo-senpi/tsconfig.json` exited 0 again with no output. Both confirmation transcripts are appended to task-3.log after the original GREEN runs. The 193-pass/1-fail state no longer exists anywhere in the final tree; it survives only as the preserved pre-repair transcript.

Follow-ups completed: the existing case is titled `registers all nine tools when a test host is supplied and no host flag exists`; its count now asserts 9. The fake host implements all five added methods, both name lists contain the nine tools in registration order, and the other six-tool title now says nine. All three original cases remain. The lead's scope widening resolved the previous blocker; both final verification commands exit 0 and their GREEN transcripts are appended to task-3.log.

## WHY IT IS ENOUGH

The focused passing coverage drives tool.execute with Senpi's fifth argument and verifies routed side effects, durable-vs-routing identity, receipt replay and isolation, bounded machine-readable errors, workspace boundaries, and actual JSONL frames over an isolated test socket. The test socket subscribes to listening/close events before triggering them and uses bounded aborts, not polling or sleeps. The implementation reuses the same executor for all nine tools, so caller identity and host errors take one path; unsupported thinking rejection completes a receipt rather than abandoning a known non-mutating operation.

This covers the scoped implementation, fake-host wire contract, registration consumers, and the required complete-suite/typecheck gates. The preserved failed real-host probe also documents a separate pre-existing first-frame transport limitation; the successful unit gates must not be represented as a live-host QA pass.

## WHAT WAS OMITTED

No commits, staging, stash, checkout, reset, generated artifact edits, production session changes, credential reads, or edits outside the lead-authorized write scope. No tests were deleted, skipped, or marked only. Existing test bodies remain unchanged except the explicitly requested registration-name and nine-tool-count expectations; the tools.test.ts and component.test.ts host fixtures were extended as requested.

Documentation/contracts/metadata are outside this node's scope. Full packaged-plugin build/test:senpi and end-to-end model generation were not run; the build was intentionally in-memory to avoid generated-file writes outside scope. The live probe loaded no extension and stopped at pre-existing openSession transport handling, so deployed discovery/activation and new controls against a live host remain unverified. No secret-bearing logs or real credential values were recorded. Other platforms were not executed (this workstation is darwin/arm64).

Files changed by this node:
- packages/omo-senpi/src/components/thread/tools.ts
- packages/omo-senpi/src/components/thread/tools.test.ts
- packages/omo-senpi/src/components/thread/live-surface.ts
- packages/omo-senpi/src/components/thread/live-surface.test.ts
- packages/omo-senpi/src/components/thread/component.test.ts (host fixture, name lists, nine-tool count, and titles under the widened scope)
- packages/omo-senpi/src/extension/thread-policy.test.ts (name list only)
- .omo/evidence/20260921-thread-tools-revival/task-3.log
- .omo/evidence/20260921-thread-tools-revival/task-3-README.md

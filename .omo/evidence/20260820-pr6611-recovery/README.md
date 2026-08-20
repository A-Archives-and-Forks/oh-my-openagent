# PR #6611 recovery evidence

## Recovery and rebase receipt

- Reused only `/Users/sungsoopark/Documents/GitHub/oh-my-openagent-wt/st_01a01d18-pr6611`. It was a clean, uniquely named PR #6611 child worktree with the prior child task and PR-specific evidence. No other worktree was modified.
- Published fork head: `3d0694b3084e52aa90777c0bbaa7156b79900359`.
- Original PR base: `00bd5b2fc7ca98ecc4732a387033a3c50aa67b0a`.
- Refreshed current `origin/dev`: `e676fef9d8728434b06b8b6bb6b282e8af1246a8`.
- Reused rebased head before this recovery fix: `d5c5918d5da58b0400125c1e67aeeffaf52ed252`; it has refreshed `origin/dev` as an ancestor. The prior rebase range mapping is retained at `../20260820-pr6611-seven-blockers/post-rebase-range-diff.txt`.
- No further history rebase was needed because the reusable child was already based on the refreshed dev head. The existing rebase receipt records the only deliberately skipped non-PR change: `dde2ea84d` completion-fixture stabilization, superseded by the stronger current-dev fixed-clock implementation. The seven requested runtime-fallback fixes remain as the rebased commits `f603b5b37`, `891937ea1`, `3aba9d1d6`, `62491bd6c`, `b7ee41a64`, and `fc1c6312d` plus their paired test/evidence series.
- The CI-exact root suite exposed one genuine current-dev release-artifact conflict: both `origin/dev` and the rebased head embedded `5.0.0-beta.8` in the generated Codex installer while root and Codex manifests are `5.0.0-beta.12`. `codex-installer-version-baseline-red.txt` proves the baseline and the origin comparison. The surgical generated repair updates that embedded version and its body digest only; `codex-installer-minimal-repair-green.txt` proves version parity plus source and body marker integrity.

## Current-head review repair

The remaining current review thread identified a no-timeout race in `session-status-handler.ts`: a retry key was retained for an event rejected only because the fallback prompt was still in flight. Once that prompt was acknowledged, an identical genuine retry event was still deduplicated and could not advance the fallback chain.

- `retry-key-inflight-red.txt` is failing-first evidence. The deterministic deferred dispatch produces one abort instead of the expected two on the unchanged handler.
- The repair deletes the just-recorded retry key on the no-timeout in-flight skip path. Accepted events retain their key before async work, preserving existing duplicate protection.
- `retry-key-inflight-green.txt` passes the exact race: after the first fallback acknowledgement, the repeated status advances from `openai/gpt-5.4` to `google/gemini-2.5-pro`.

The post-CI exact-head Codex review then found a second, independent generation-boundary bug in `chat-message-handler.ts`: manual model/variant reset replaced state and cleared the watchdog but left the old retry-in-flight marker. A retryable failure on the new generation was therefore skipped; the stale dispatch could also later clear a new generation's marker.

- `inflight-generation-red.txt` fails deterministically on the unchanged implementation: reset retains the marker, and completion of the stale deferred message lookup removes a newly started generation's marker.
- Manual reset now clears the old marker. `auto-retry-dispatch.ts` clears a marker in `finally` only when its captured `FallbackState` is still current, so a stale dispatcher cannot affect a new generation.
- `inflight-generation-green.txt` passes the two focused files (19 tests, 0 failures), including the deferred old/new dispatcher interleaving without a time-based wait.

## Verification

- `focused-runtime-fallback-and-prompt-gate.txt`: 398 pass, 0 fail across all runtime-fallback tests, plugin chat-message coverage, and prompt-gate tests. Post-review `runtime-fallback-after-generation-fix.txt`: 284 pass, 0 fail across the complete runtime-fallback directory.
- `typecheck.txt` and CI-node-24 `typecheck-node24.txt`: root, scripts, and every package typecheck passed. Post-review `typecheck-generation-fix.txt`: every package typecheck passed.
- `build.txt` and `build-generation-fix.txt`: `bun run build` completed; the latter freshly built the post-review source surface for QA.
- `lsp-daemon-tests.txt`: exact vendored daemon suite passed.
- `root-bun-test.txt`: the full default root suite passed 15,982 tests, skipped 13 platform-gated tests, failed 0. CI-exact Node 24 `root-bun-test-node24-final.txt` passed 13,921 tests, skipped 12 platform-gated tests, failed 0.
- CI-node-24 `test-codex-node24.txt`: the complete `bun run test:codex` gate passed. Its isolated Node 24/npm 11 toolchain matches CI; a prior Node 22/npm 10 nested-pack attempt is retained locally as `test-codex-first-attempt.txt` and was not treated as a product failure.
- `test-senpi.txt`: `bun run test:senpi` passed 2,061 tests, skipped 1, failed 0.

## Isolated OpenCode QA

The `opencode-qa` source-built server/API case was selected because this changes a lifecycle handler.

- `opencode-qa-common-self-check.txt` passed, including isolated-XDG cleanup and isolated HOME shim checks.
- `opencode-qa-sse-self-test.txt` passed the isolated SSE probe.
- `opencode-source-qa.sh` drove the exact freshly built `dist/index.js` with OpenCode 1.18.18, a local fake OpenAI-compatible provider, an authenticated isolated-XDG server, and a pre-subscribed SSE stream.
- `opencode-source-qa.txt` records HTTP 204, `server.connected`, `session.status`, `message.updated`, and `message.part.updated` carrying `fake response 2`. This proves the changed lifecycle-event surface reached the loaded source-built plugin.
- Post-review `opencode-source-qa-generation-debug.txt` completed the same source-built isolated-server script against bundle SHA-256 `a35b35707745a54cf4220f4ffb7cbbeece8686cc90125473b48fbf345eaa9abb`: HTTP 204, subscribed `session.status`, `message.updated`, and `message.part.updated` with `fake response 2` all occurred. The first plain invocation exceeded the external 300-second command window before producing a receipt; the instrumented rerun completed every script assertion.
- The sandbox held one QA session. The real host DB remained exactly 7,586 sessions before and after. The QA sandbox was removed and both its OpenCode and fake-provider processes stopped.

## Isolated Codex installer QA

The release-artifact repair is a shipped Codex installer surface, so `codex-qa` was also run with Node 24 and Codex CLI 0.146.1.

- `codex-qa-common-self-check.txt` passed isolated-home setup and mock-provider checks.
- `codex-install-verify.txt` installed the local build into an isolated `CODEX_HOME`, found plugin cache version `5.0.0-beta.12`, enabled `omo@sisyphuslabs`, linked ten component bins and agent TOMLs, and asserted the real Codex config was unchanged.
- `codex-app-server-plugin.txt` drove a real isolated app-server turn against the local mock model. It completed with the mock reply and observed completed `sessionStart`, `userPromptSubmit`, and `stop` plugin hooks.
- The real `~/.codex/config.toml` SHA-256 was `c1318c425637e1af22860352ef809a62e51012ed7527f2aaed4d7f17e9855df1` both before and after.

## Omitted material

The repetitive full-suite logs are retained locally as named above rather than duplicated in the review payload. No provider secrets, auth passwords, tokens, or raw environment dumps are included. Pre-existing `oqa-xdg.*` sandbox directories and unrelated tmux sessions were observed after QA but were not task-owned and were left untouched.

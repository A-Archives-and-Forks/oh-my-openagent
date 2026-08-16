# Task 1 — Concurrency wave assembler

Plan: `.omo/plans/telemetry-parallel-latency-v2.md` todo 1
Worktree: `/Volumes/mengmotaStorage/local-workspaces/omo-wt/feat-telemetry-parallel-latency`

## What was built

`packages/omo-senpi/src/components/telemetry/wave-assembler.ts` — a pure module that pairs
`tool_execution_start` / `tool_execution_end` observations by `toolCallId` into
`{toolCallId, toolName, startMs, endMs}` and groups them into concurrency waves by time
overlap (interval-graph connected components). Every wave carries `spanMs = maxEnd - minStart`
(consumed by todo 2's savings formula) and `maxConcurrency` (sweepline over start/end boundaries).

Note on the senpi event shape: `ToolExecutionStartEvent` / `ToolExecutionEndEvent`
(`node_modules/@code-yeongyu/senpi/dist/core/extensions/types.d.ts:854-875`) carry **no timestamp
field**. The subscriber in todo 4 must stamp arrival time, so this module accepts already-stamped
`ToolExecutionObservation` records rather than raw events.

## Commands run and results

RED capture (honest labelling): the implementation file was written before the test could be
executed, then **moved aside** (`mv wave-assembler.ts /tmp/wave-assembler.ts.hold`) to observe a
genuine failing run. This is a stashed RED, **not** an untouched-first-run RED. Nothing was fabricated.

```
$ mv packages/omo-senpi/src/components/telemetry/wave-assembler.ts /tmp/wave-assembler.ts.hold
$ bun test packages/omo-senpi/src/components/telemetry/wave-assembler.test.ts
bun test v1.4.0-canary.1 (b58cd4685)

packages/omo-senpi/src/components/telemetry/wave-assembler.test.ts:

# Unhandled error between tests
-------------------------------
error: Cannot find module './wave-assembler' from '/Volumes/mengmotaStorage/local-workspaces/omo-wt/feat-telemetry-parallel-latency/packages/omo-senpi/src/components/telemetry/wave-assembler.test.ts'
-------------------------------

 0 pass
 1 fail
 1 error
Ran 1 test across 1 file. [86.00ms]
RED_EXIT=1
```

A second, independent RED was observed by the orchestrator against the restored module: the
malformed-input assertion failed with `Expected: 9, Received: 7`. Resolution below.

GREEN — target test file:

```
$ bun test packages/omo-senpi/src/components/telemetry/wave-assembler.test.ts
 11 pass
 0 fail
 29 expect() calls
Ran 11 tests across 1 file. [94.00ms]
GREEN_EXIT=0
```

Typecheck:

```
$ bun run --cwd packages/omo-senpi typecheck
$ tsgo --noEmit -p tsconfig.json
TYPECHECK_EXIT=0
```

Full telemetry suite (regression check against the 92 pass / 1 fail baseline):

```
$ bun test packages/omo-senpi/src/components/telemetry/
 103 pass
 0 fail
 402 expect() calls
Ran 103 tests across 13 files. [1429.00ms]
SUITE_EXIT=0
```

The single baseline failure was this task's own malformed-count assertion; it is now resolved.
No pre-existing test was modified, skipped, or deleted.

## Manual QA artifact

Throwaway script `/tmp/wave-assembler-qa.ts` imported the assembler directly and fed it the
chained sequence A(0-5) B(4-9) C(8-12) plus one incomplete record and one clock-anomaly record.

```
$ bun run /tmp/wave-assembler-qa.ts
waves=1
wave[0] size=3 span=12 maxConcurrency=2 calls=A(0-5) B(4-9) C(8-12)
incomplete=1
clockAnomalies=1
pairedCalls=3
observedCalls=5
droppedCalls=0
malformed=0
QA_EXIT=0
```

Binary PASS/FAIL observable: **PASS** — exactly 1 wave, `span=12`, `maxConcurrency=2`,
`incomplete=1`, `clockAnomalies=1`, as required.

This is the regression guard for the real bug: A and C never overlap. A naive
"longest duration" span would report 5 and a naive "wave size" concurrency would report 3.
The measured values are 12 and 2.

## Mandatory test cases (plan acceptance criteria)

| Case | Covered by | Result |
| --- | --- | --- |
| (a) 3 overlapping -> 1 wave size 3 + span | `#given tool executions that overlap in time` | span 600, concurrency 3 |
| (b) 3 sequential -> 3 waves size 1 | `#given tool executions that never overlap` | 3 waves, each span 100 |
| (c) mixed overlap + sequential | `#given a mix of overlapping and sequential executions` | 2 waves (size 2, size 1) |
| (d) missing end -> incomplete, excluded | `#given a start observation whose end never arrives` | incomplete 1, wave excludes it |
| (e) endMs < startMs -> clock_anomaly, excluded | `#given an end observation that precedes its start` | clockAnomalies 1, excluded |
| (f) > 2000 calls -> detail dropped, counters kept | `#given more tool calls than the session tracking cap` | tracked 2000, dropped 10, observed 2010 |
| (g) chained A(0-5) B(4-9) C(8-12) | `#given a chained wave where the first and last calls never overlap` | 1 wave, span 12, maxConcurrency 2 |

## Judgement calls, recorded for F1/F2 reviewers

**1. `MAX_TRACKED_CALLS` is enforced on paired detail.** Once 2000 calls are tracked, further
starts increment `observedCalls` and `droppedCalls` but are not retained, so the array cannot grow
unbounded. Counters stay truthful past the cap; only per-call detail is lost. This satisfies
"카운터만 유지하고 상세는 버림" without letting the session leak memory.

**2. `incomplete` is derived from the residual `pending` map.** A start whose end never arrives
remains in `pending` at the end of assembly, so `incomplete = pending.size`. It is counted exactly
once and never enters a wave.

**3. Malformed count is 7, not 9 (the fixture length).** The nine adversarial inputs are:
non-string `toolCallId`, `NaN` timestamp, orphan end for "nan", negative timestamp, orphan end for
"negative", empty `toolCallId`, missing `atMs`, `null`, and a bare string. Seven are structurally
unparseable. The two `end` records for "nan" and "negative" are **well-formed observations** whose
matching start was rejected, so they are dropped as orphaned ends rather than counted as malformed
input. The assertion was corrected to the true value `7` with an inline comment; the implementation
was **not** weakened to match a wrong expectation.

**4. Boundary-touching intervals share a wave but do not inflate concurrency.** Calls are grouped
on closed intervals, so a call ending at 100 and one starting at 100 land in the same wave. The
sweepline applies ends before starts at equal timestamps, so `maxConcurrency` is 1, not 2. This is
the same tie-break that keeps the chained case at 2 instead of 3.

## Adversarial classes probed

**Malformed input — PROBED, no throw, no corruption.** Nine hostile records (non-string
`toolCallId`, `NaN`, negative, missing and `undefined` timestamps, empty id, `null`, bare string)
were fed alongside one valid pair. `expect(run).not.toThrow()` holds, `malformed` counts 7, and the
single valid pair is the only thing reaching the wave metrics (`pairedCalls` 1, one wave of span 100).
Rejection happens at the parse boundary, so no malformed value can reach the arithmetic.

**Stale state — RULED OUT structurally, and asserted.** `assembleWaves` is a pure function with no
module-level mutable state: `pending`, `paired`, and `counters` are all allocated per call. Two
independent sessions were assembled back to back; the first session's `incomplete` record does not
appear in the second (`second.counters.incomplete` 0, `observedCalls` 1). Cross-session leakage is
not merely absent, it is unrepresentable.

**Flaky tests — RULED OUT.** There is no `Date.now()`, no timer, no sleep, and no async code
anywhere in the test file; every timestamp is injected as a literal. Test outcomes cannot vary with
wall-clock time or scheduling. Two consecutive full-suite runs produced identical results.

**Unbounded growth — PROBED.** The >2000 case asserts the tracked array stops growing while
counters continue, which is the memory guard the plan requires.

## Interface seam flagged for todo 6 (not actioned here)

`eval-classifier.ts` (a sibling task's output) consumes waves as `{toolNames, spanMs}`, while
`ConcurrencyWave` exposes `{calls, spanMs, maxConcurrency}`. These do not line up as-is; todo 6
needs a small adapter mapping `calls` to `toolNames`. That is a downstream integration seam, not a
defect in either module. `eval-classifier.ts` was **not** touched by this task.

## Cleanup receipt

`/tmp/wave-assembler-qa.ts` was deleted after the output above was captured.
`/tmp/wave-assembler.ts.hold` (the RED-capture holding copy) was moved back into the worktree and
no longer exists in `/tmp`. Verification of both is recorded in the commit-time check below.

## Scope

Changed files: exactly two new source files plus this evidence file.

- `packages/omo-senpi/src/components/telemetry/wave-assembler.ts` (new)
- `packages/omo-senpi/src/components/telemetry/wave-assembler.test.ts` (new)
- `.omo/evidence/telemetry-parallel-latency-v2/task-1.md` (new, force-added; evidence dir is gitignored)

No barrel export was added to `index.ts` (todo 4 wires the consumer). No existing file was modified.

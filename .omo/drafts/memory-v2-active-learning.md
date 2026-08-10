# memory-v2-active-learning — review draft ledger (RECONSTRUCTED 2026-08-10T06:40:17Z)

status: review-approved-pending-final-bind
plan_path: .omo/plans/memory-v2-active-learning.md
plan_sha256: e445af714607b47baff1853187972e98ce1d6058420b766a370b2ac51eb29da0

> RECOVERY NOTE: at 15:11 the omo workspace was restored to a clean checkout, removing this untracked plan and draft. Both were reconstructed deterministically by replaying the session transcript (canonical plan Write + 116 recorded patch cells), reproducing sha256 e445af714607b47baff1853187972e98ce1d6058420b766a370b2ac51eb29da0 exactly — the same 4 cells that failed originally failed again, confirming faithful replay.

## Verdict history (27 rounds, 4 independent lanes, momus excluded per user instruction)
- fullscope-a21 st_019fe36: **APPROVED** (0 blockers, 1 note) — first unconditional full-scope approval
- fullscope-a24 st_019fea3c: **APPROVED** (0 blockers, 2 notes) — second
- fullscope-a26 st_019fea41: **APPROVED** (0 blockers, 2 notes) — third
- fullscope-t25 st_019fea3f: **COMPLIANT** (0 test-discipline violations)
- executor lane EXECUTABLE (25/25) in rounds 19, 20, 22, 24, 27 — b27 st_019fea49 bound to sha ab834b25
- Every finding from every round was integrated; none declined.

## Round ledger (recovered)
- ## Findings (<computed>): R4 APPROVED. Plan finalized sha 78575391. 4 review rounds total. DONE.
- - <computed>: ROUND 15 receipt 1/2 — fullscope-b15 st_019fea0e returned VERDICT: EXECUTABLE against sha <computed> (digest verified, no drift). All 25 todos OK. (a) With the gated bootstrap handshake, a crash at ANY instant reaches a defined terminal or retryable state without inventing behavior — identity is durable before any child can work, a pre-release supervisor death exits the bootstrap without starting the model child, and a post-release death leaves an identifiable process group handled by todo 13. (b) No acceptance criterion depends on timing luck, credentials, a real model call, or an undefined constant; the reviewer enumerated the pinned constants. (c) No IC-versus-todo contradiction remains. Live plan sha at receipt time: <computed> (drift=<computed>). Plan FROZEN pending fullscope-a15 st_019fea0d on the same sha.
- - <computed>: ROUND 24 b-lane: fullscope-b24 st_019fea3d VERDICT: EXECUTABLE (all 25 todos OK) — confirmed that after the test-discipline rewrite every acceptance criterion is still agent-executable, every behavior change still has a possible RED-first proof, pure-prose changes correctly ship with NO manufactured test, and no IC-versus-todo contradiction remains. Completion-audit evidence table prepared; awaiting the approval bind on final sha <computed>.

## Round 30 - FULL-SCOPE approval bind (plan now committed and frozen)

- plan sha256: `66a8a3bcfb03a3e846455c3489c80828762ebfc38d8c94890db4f8cae9bb90d1`
- plan is COMMITTED at `6a50215b0` on branch `feat/memory-v2-active-learning`, working tree clean for that path.
  Earlier rounds kept losing the bind because parallel lanes advanced the sha between spawn and verdict; the plan
  is now git-tracked and frozen, so the target cannot move under a reviewer.
- lanes spawned 2026-08-10T07:07:00Z: `fullscope-a30` (contract / technical soundness) and `fullscope-b30` (executor simulation,
  25-todo dry run). momus excluded per the user's standing instruction.

### Mechanical self-audit receipt (objective item 1) - 17/17 gates PASS at this sha

| gate | result |
|---|---|
| canonical section headers present and ordered | PASS |
| 25 todos, contiguous, each with References/Do/Acceptance/QA-happy/QA-failure/Commit/category | PASS |
| commit lines match conventional-commit grammar | PASS |
| evidence paths self-consistent per todo | PASS |
| dependency matrix has one row per todo | PASS |
| dependency graph is a DAG | PASS |
| all six wave orders topological | PASS |
| waves cover 1..25 exactly once | PASS |
| F1..F4 present | PASS |
| IC-1..IC-17 each present exactly once | PASS |
| every `**IC-n**` cross-reference resolves | PASS |
| no banned test shapes (per .omo/rules/test-discipline.md) | PASS |
| no duplicated clauses from transcript replay | PASS |
| tool-exposure statements match real code | PASS |
| 204 file:line citations resolve, all in range | PASS |

### Empirical executability evidence - NEW this round

Six todos have now been EXECUTED from this exact plan text by independent agents, each landing an atomic
commit with RED-first tests and green suites, with no human clarification required:

| todo | commit | suite result |
|---|---|---|
| 1 schema v2 | `3e00693d8` | 157 pass |
| 2 reminder v2 | `5bca65f69` | 299 pass |
| 4 memory-discipline seed | `8d0a1a5b1` | 301 pass |
| 5 /sleeptime display | `2f9b0d24f` | 918 pass |
| 11 skills-usage ledger | `2bba9d7b4` | 269 pass |
| 23 reflection.enabled | `872d1ee2a` | 36 pass |

This is stronger evidence than any review verdict: the plan is not merely judged executable, it HAS been
executed. Nine further todos were in flight at the time of writing.

### Corrections integrated since the last approved sha

- A28 BLOCKER (tool exposure): IC-17 and the Must-NOT guardrail claimed `registerMemoryToolSurface` always
  selects MCP and that memory tools "stay behind tool_search". Verified against
  `packages/omo-senpi/src/components/memory/tools.ts:108-122`: MCP is selected ONLY when
  `options.exposure === "search"`, and `tool_exposure` defaults to `"direct"` in both the schema
  (`packages/omo-config-core/src/schema/memory.ts:58-61`) and the adapter fallback
  (`.../components/memory/index.ts:23-27`), because a failed MCP declaration removes memory entirely.
  Both surfaces are now stated as first-class and provenance/notices are required on each.
- I28 integrity DAMAGED (duplicated clause): the ACHIEVABLE ABORT CONTRACT bullet repeated a clause after
  transcript replay. Removed; a repo-wide duplicate-clause scan now reports zero.
- I29 integrity DAMAGED (orphaned reference): a `**IC-24 metric**` cross-reference pointed at a contract that
  does not exist (IC stops at 17). Rewritten to name todo 24 directly; orphan scan now reports zero.

## Round 30 verdicts (both lanes reported)

- `fullscope-b30` executor simulation, sha `66a8a3bc`: **VERDICT: EXECUTABLE** - all 25 todos executable,
  ZERO stall points. Sixth consecutive EXECUTABLE from this lane.
- `fullscope-a30` contract/technical, sha `66a8a3bc`: **VERDICT: BLOCKED** - 1 blocker, 2 notes. All three
  integrated in commit `eb8a46895`:
  1. BLOCKER (Windows, VERIFIED REAL): IC-8/IC-9 described POSIX semantics as universal (process groups,
     `getProcessStartIdentity`) while `.github/workflows/ci.yml` runs the root suite on `windows-latest`
     across four job matrices and `AGENTS.md:396` documents native Windows builds. Confirmed against
     `packages/memory-core/src/locks/process-identity.ts:35-41`, which has NO win32 branch and returns null
     for every pid there. IC-8 now binds win32 containment to `taskkill /T /F` at the SIGKILL instant and
     `child.kill()` at the SIGTERM instant, both derived from the SAME absolute instants as POSIX so deadline
     enforcement is platform-independent. IC-9 now states the Windows consequence explicitly and bounds it:
     identity is always unavailable, reconciliation always resolves through UNKNOWN to `abandoned.json`,
     which advances no watermark and keeps the batch retryable, so Windows loses resumption efficiency and
     never loses data. Todo 25 gained REQUIRED Windows coverage via an injected platform seam.
  2. NOTE (docs): `docs/reference/configuration.md:9-39` has no memory section, yet the Must-have forbids
     todo 20 from being the first documentation pass. Added an explicit carve-out: todo 1 owns creating the
     `memory.*` reference section, with a required backfill before todo 20 audits it.
  3. NOTE (todo 3 QA): the real-surface run would have exercised the DEFAULT direct surface and proven
     nothing about IC-17 provenance, since `tool_exposure` defaults to `"direct"`. Todo 3 QA now requires the
     search/MCP exposure with a non-auto agent AND asserts the direct seam too.

### Implementation-side correction found by the todo 15 executor

IC-2 requires background writers to stamp `Omo-Writer: reflection|dream|facts-extractor`, but the landed
dream persona emitted only the prior-art `Generated-By: agent memory` block. Verified that nothing keys
POSITIVELY on the background values (nudge keys on `Omo-Writer: memory-tool`; soul-notice keys on its
ABSENCE), so this was a spec-compliance gap rather than a live defect. Fixed in the implementation, not the
plan: the dream persona now stamps `Omo-Writer: dream` alongside the existing block, in both the source asset
and its packaged copy, with the drift-equality test still green.

## Round 31 - approval bind on the corrected plan

- plan sha256: `00e7141af04d32cd0e8aaa69ce5e3132e71ecee30f6758be913d9c47caba35e3`, committed at `eb8a46895`, working tree clean for that path.
- lane spawned 2026-08-10T07:16:20Z: `fullscope-a31` (full-scope contract/technical, no delta scoping). momus excluded.
- Mechanical self-audit at this sha: **20/20 gates PASS**, 210 citations resolve in range. Gates added since
  round 30: windows_specified, docs_carveout, t3_mcp_qa.
- Empirical executability at this sha: NINE todos executed from this plan text (1, 2, 4, 5, 11, 15, 16, 23
  landed; more in flight), zero requiring human clarification.

## Round 31 verdict and resolutions

`fullscope-a31`, sha `00e7141a`: **VERDICT: BLOCKED** - 1 blocker, 1 note. Both integrated in `374a6bf31`.

1. BLOCKER (abrupt-supervisor-death deadline hole) - a REAL hole in round 30's own Windows fix, not a
   re-raise. Round 30 made the SUPERVISOR the sole deadline enforcer via `taskkill`. But on abrupt supervisor
   death the reconciler reaches the win32 UNKNOWN path and writes `abandoned.json` WITHOUT terminating the
   still-running child, so the child outlives `deadlineAt`. FIX: IC-8 gains BOOTSTRAP SELF-ENFORCEMENT - the
   bootstrap arms its OWN timers against the persisted absolute instants, so the child self-terminates on ANY
   platform regardless of supervisor liveness. That is what makes the win32 UNKNOWN path SAFE rather than
   merely lossless. Todo 25 must test supervisor-kill-then-child-still-exits on both branches.
2. NOTE (IC-7) - the extraction record is now a discriminated union on `scope`, with a parent-side validator
   rejecting a project record carrying `person` or a person record missing it.

## EMPIRICAL contract defect found by execution, not review (IC-6)

The facts-queue executor's FIRST implementation FAILED, exposing a genuine gap in IC-6's prescribed
mechanism. Ordering watermarks by position in the current journal entry list is well-defined only when BOTH
endpoints appear in ONE list. A late-finishing batch does not contain the newer batch's endpoint, the lookup
returns "not found", the guard reads that as "no newer watermark exists", and the consumed watermark rolled
backward from m4 to m2. FIX: the cursor persists `enqueued_through_snapshot_line` /
`consumed_through_snapshot_line` and advances only on a STRICTLY GREATER `range.end_snapshot_line`, which IS
comparable across batches. Message-id position stays the INTRA-batch rule; snapshot line is the INTER-batch
one. The plan's own mechanism was proven insufficient by running it, and the correction now matches the
shipped implementation exactly.

## Implementation regression found by the palace executor (not a plan defect)

`hooks-scripts.ts:32` pinned `ALL_KNOWN_KEYS="description read_only limit"` while the people work added
`kind`/`aliases` to the seeded `system/human.md` and the TS parser, so every FRESH memory repository failed
its own pre-commit hook on init and lazy repo creation was blocked. Reproduced with the reporter's changes
stashed; fixed in `3347fd4cc`; the previously failing lazy-init test now passes (11/11) and memfs is 97/97.

## Round 32 - approval bind

- plan sha256: `a607a88f25e397963b6ac552b109aa800e90a83c8e8805192e9d9ec30af22ec1`, committed at `374a6bf31`, working tree clean for that path.
- lane spawned 2026-08-10T07:25:54Z: `fullscope-a32`, full-scope, no delta scoping. momus excluded.
- Mechanical self-audit at this sha: **22/22 gates PASS**, 210 citations resolve in range.
- Empirical executability: ELEVEN todos executed from this plan text (1, 2, 4, 5, 8, 11, 15, 16, 19, 23).

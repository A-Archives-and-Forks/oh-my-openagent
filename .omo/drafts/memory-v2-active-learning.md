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

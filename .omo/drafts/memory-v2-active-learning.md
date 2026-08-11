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

## Round 32 verdict and resolutions

`fullscope-a32`, sha `a607a88f`: **VERDICT: BLOCKED** - 1 blocker, 1 note. Both integrated in `6cf4e8589`.

1. BLOCKER (DESTRUCTIVE RECOVERY - user data loss). The plan mandated `git merge --abort` else
   `git reset --hard HEAD`, and facts reconciliation unconditionally reset and checked out affected paths
   before retrying. Memory is USER DATA (persona, notes, people cards, and any hand edit made after a crashed
   run), and this repository's posture is explicitly refuse-rather-than-clobber: integration returns
   `parent_dirty` without mutating (`reflection/worktree.ts:96-98`) and `cleanCheck` throws `DirtyRepoError`
   (`git/repo.ts:119-123`). Either mandated path would have silently destroyed those edits. FIX: recovery is
   now OWNERSHIP-PROVEN. Reflection may `git merge --abort` ONLY when `.git/MERGE_HEAD` names the
   `validatedTipSha` this run recorded; otherwise the tree is left byte-identical and the run settles
   `parent_dirty`. Facts restoration is PATH-SCOPED: a path is restored only when its current blob sha equals
   the post-write sha this run produced, and on ANY drift every path is left untouched, no watermark advances,
   and the batch stays queued. `git reset --hard` is now FORBIDDEN and appears nowhere as a mandated action.
2. NOTE (IC-6): the inline `consumed.json` schema now carries `end_snapshot_line`, matching the shipped type.

## Round 33 - UNCONDITIONAL FULL-SCOPE APPROVAL

**`fullscope-a33` (deep lane, fresh reviewer, full scope, no delta scoping), plan sha256
`6f04d2102f8ad82d64746e72f46232974602e0a65dc764c6a21314ae9728a4ec`: `VERDICT: APPROVED`.**

- ZERO blockers. Two NOTES only, both explicitly non-blocking.
- Verdict time: 2026-08-10T07:40:42Z. Reviewer verified the digest itself before reviewing.
- The reviewed sha IS the final on-disk sha: the plan is committed at `6cf4e8589` with a clean working tree
  for that path, and `sha256(.omo/plans/memory-v2-active-learning.md)` equals the reviewed digest exactly.
- Self-audit at this sha: 24/24 mechanical gates PASS, 215 citations resolve in range.

### The two NOTES (recorded, neither blocking, one actionable against the CODE not the plan)

1. Todo 25's ALREADY-LANDED implementation predates the strengthened IC-8: the supervisor still routes win32
   termination through `process.kill()` (`worker/memory-run-supervisor.ts:69`), which does not kill a Windows
   process TREE, and the bootstrap only awaits child closure rather than arming its own absolute-deadline
   timers. This is implementation debt created by the contract being strengthened AFTER that todo landed, not
   a plan defect. Actioned: todo 25 reopened to comply before the F1 gate.
2. Task-boundary friction between todos 25 and 13 over which one owns the UNKNOWN-to-`abandoned.json`
   reconciliation assertion. IC-9 fully decides the behavior, so this is placement, not a missing decision.

### Verdict history across the whole effort

| lane | rounds | outcome |
|---|---|---|
| full-scope contract | a21, a24, a26, a30, a31, a32, **a33** | 4x APPROVED including the final unconditional bind |
| executor simulation | b19, b20, b22, b24, b27, b30 | EXECUTABLE 25/25, zero stalls, every round |
| test-discipline audit | t25 | COMPLIANT, zero violations |
| integrity audit | i28, i29 | 2 reconstruction defects found and fixed |
| contract audit | multiple | all findings integrated |

Thirty-three rounds. Every finding raised across every lane was integrated; none was declined.

## Post-approval: F1-F4 final verification wave

All 25 todos implemented, then the plan's own final verification wave ran on the branch. First pass: F1 FAIL (5 rows), F2 FAIL (4 classes), F3 FAIL (stale-bundle race), F4 FAIL (metadata drift). Every finding was fixed:

- MH-1 runtime gating + schema-default resolvers + drain abort threading (aa7ef94e4)
- spawn.ts empty catches (aa7ef94e4); LOC splits S1-S4 (0baef0c1f, 7e4e0c505, feb6faa3a, af2f66c1b)
- MH-4 single-carrier + MN-6 contradiction preservation + dash fixes (47f7c863f)
- banned test shapes reworked with mutation checks (2e61de173)
- bundle shipped 867,366 -> 974,066 bytes, budget documented to 1MB (f801a00c5)
- branch synced through v5.0.0-beta.5 (43e47c610, 8a705227e)

Second pass: F2 PASS (16e7fe518); F3 PASS (856e981a3, all 7 scenario steps green live); F1 rerun found two residuals - the skill still restated the announcement (now a pointer to the persona only), and the abort signal was not threaded through the composite facts enqueue publish boundary, SkillsUsageTracker.flush, and FactsExtractorRunner.launchPendingOnce. Threading added with function-boundary checks (narrowing-proof), each proven by a focused boundary test: queue publishes nothing and cursor untouched; skills ledger never written; facts reserves no run, spawns no child, batch stays retryable. F4 rerun residual is branch currency only (origin/dev keeps advancing; re-sync at land time).

## Post-approval: production defect report from live use (senpi command resolution)

The user ran the feature and reported repeated background failures, in two distinct shapes:

```
memory reflection failed  run:reflection-run-{5,6,7,8,9,49,50}  category:quick
detail:sandbox-exec: execvp() of 'senpi' failed: No such file or directory

memory reflection failed  run:reflection-run-{51..57}  category:quick
detail:Error: Model "apitopia/z-ai/glm-5.2-ultrafast-unlocked" not found.
```

Two independent causes; only the first is a code defect.

**Defect (fixed): the senpi command resolution could yield an unrunnable command.**
`resolveDefaultSenpiCommand` (worker spawn payload) and `defaultSenpiCommand` (people-ask) both
ended in `?? "senpi"`. That fallback is not a runnable command: when senpi is launched from an
environment whose PATH lacks the senpi bin directory, the PATH scan returns null, the bare name is
handed to the supervisor, and the child dies at `execvp`. A PATH scan cannot be the last resort
because the child inherits the same PATH that already failed.

Reproduced deterministically before fixing: with `PATH=/nonexistent-bin` the scan returns null and
the resolver emits `"senpi"`. Verified against the real installation on this host, where senpi is a
`#!/usr/bin/env node` shim at `~/.local/bin/senpi` that re-spawns `dist/cli-main.js`, so the running
process argv never names a `senpi` executable either.

Fix: `worker/senpi-command.ts` resolves the CLI PATH-independently. The extension only ever runs
inside senpi, so the running installation is authoritative: the senpi module search paths are walked
to `<senpi package>/dist/cli.js` (the published `bin` target; the package blocks `./package.json` in
its `exports`, so the manifest cannot be resolved directly), a PATH-discovered launcher is followed
through its symlink, and the interpreter executing this process is the final fallback. Every result
is an absolute path. Both call sites now use it.

Evidence: failing-first test in `worker/spawn.test.ts` pinning that a PATH that cannot resolve senpi
never yields the bare name and always yields an existing absolute command, plus an override-preserved
test. Restricted PATH now resolves to a real `@code-yeongyu/senpi/dist/cli.js`; full PATH still
prefers the normal launcher. memory 437/437, senpi-task 1363/1363, both typechecks clean. The shipped
`plugin/extensions/omo.js` was rebuilt (bare-fallback occurrences 5 -> 0), since that generated,
git-tracked bundle is what a user's senpi actually loads.

**Not a code defect: the model error.** `senpi --list-models` succeeds (rc=0) and returns zero
`apitopia` models; the whole provider is absent from the registry. The user's `~/.omo/omo.jsonc`
pins category `quick` to `apitopia/*` models and declares no `apitopia` provider, and reflection and
facts are both pinned to `quick`. This is host configuration, not plan or branch scope; reported to
the user rather than worked around in code.

## Post-approval implementation review: live-defect hardening

The final paragraph above is superseded. The stale host configuration was real, but the repeated
model failure also exposed a code defect: the long-lived parent can resolve extension-provided
models that the intentionally clean `--no-extensions` reflection/facts child cannot load. The
worker discarded the resolved fallback chain instead of retrying the next child-visible model.

### Review round implementation-r1

- reviewed head: `e0a7b9a5b275e4ae2073fc8ee702465cbff57dcd`
- scope: production-fix delta `88d285038..e0a7b9a5b`, with the complete approved plan as binding
  contract
- security reviewer: PASS, no blocker
- hands-on QA reviewer: PASS (443 memory tests, typecheck, restricted PATH, live fallback E2E,
  cleanup and host-isolation proof)
- goal/constraint reviewer: FAIL
- code-quality reviewer: FAIL
- context reviewer: FAIL

Blocking findings accepted:

1. Retry attempts reused one run directory while a stale earlier `outcome.json` remained
   authoritative to reconciliation, and each attempt reset the full timeout.
2. The successful fallback model/thinking was not durable for crash recovery.
3. Senpi resolution returned a path string rather than `{ command, prefixArgs }`, breaking Windows
   npm shims and the no-module fallback.
4. First-turn stale-registry recovery preserved canonical `models[]` but dropped supported legacy
   `model + fallback_models`.
5. The memory skills scope intentionally returned an absent `<memory repo>/skills` path, producing
   the user's visible warning. A stale user `omo-frontend` copy also duplicated the current global
   `frontend` skill.

Resolutions:

- New run artifacts persist `attempt`, `model`, `thinking`, `launching`, and one shared
  `hardDeadlineAt`. Outcomes carry the attempt; reflection and facts reconciliation ignore stale
  generations. The supervisor clears `launching` when it records process ownership.
- Crash recovery records the persisted fallback model and thinking.
- The established Senpi launcher normalizer is exported and reused. Memory children now carry
  `{ command, prefixArgs }`; tests cover Windows npm shims, installed CLI fallback, current entry
  fallback, and an executed restricted-PATH `--version` call.
- Legacy and canonical configured fallbacks are recovered through `registry.find()` during stale
  first-turn availability.
- Missing memory skills directories contribute nothing until they exist. The stale
  `~/.agents/skills/omo-frontend` copy was preserved at
  `~/.agents/skills-disabled/omo-frontend-20260811`.

Evidence:

- stale-attempt mutation proof: forcing all outcomes to match fails both reflection and facts tests
- real model fallback E2E: `extension-only/primary` -> `omo-mock/mock-1`, outcome `merged`
- real rebuilt-Omo startup: no missing skill path warning, no frontend collision, absent skills dir
- final local gate: 451 passed, 0 failed, 1318 assertions; omo-senpi and senpi-task typechecks clean
- evidence directory: `.omo/evidence/20260811-memory-reflection-model-fallback/`

### Review round implementation-r2

- reviewed head: `849f5f38a85b6459990c9dac9ae6971893a089ae`
- goal/constraint re-review: FAIL
- security re-review: PASS
- hands-on QA re-review: PASS
- context re-review: PASS
- quality re-review: pending when the goal verdict arrived

Remaining blocker:

- attempt N published its matching retryable outcome before attempt N+1 was durably marked
  `launching`, leaving a narrow reconciliation window.

Resolution:

- `RunLaunchManifest.nextAttempt` carries the next generation/model/thinking into the
  sentinel-owning supervisor.
- On the exact retryable model-not-found result, the supervisor advances `ledger.json` to the next
  `launching` attempt and clears old process identity before publishing the current outcome.
- A failing-first supervisor integration pinned the required ordering; focused reflection/facts
  tests, both E2Es, and the full local gate were rerun.

### Final remediation before implementation-r3

The quality re-review independently cited the same transition window and also rejected the last
bare-interpreter launcher fallback.

Final changes:

- the supervisor owns the next-attempt transition and advances the ledger before publishing the
  retryable current outcome;
- when executable, installed CLI, and current entry discovery all fail, launcher resolution throws
  `Unable to resolve a runnable Senpi launcher` instead of passing Senpi flags to bare Node/Bun;
- next-attempt construction moved into the shared retry helper, returning `runner.ts` to 250 pure
  LOC.

Final local evidence:

- supervisor handoff test RED -> GREEN;
- unresolved launcher test RED -> GREEN;
- model fallback and startup-warning E2Es PASS;
- 453 memory tests PASS, 0 fail, 1322 assertions;
- omo-senpi and senpi-task typechecks PASS.

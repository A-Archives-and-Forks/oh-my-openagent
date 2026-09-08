# QA evidence: memory ghost-active reservation self-heal (2026-09-08)

Change under test: `packages/omo-senpi/src/components/memory/worker/run-reconciliation.ts` +
`run-ghost-active.ts` (ghost reclaim) and `commands/doctor-reservation.ts` (`/doctor` check).

## What was tested

1. **Unit/integration gates (hermetic)**
   - `bun test packages/omo-senpi/src/components/memory/worker` — 241/241 pass (37 files),
     including 6 new `run-reconciliation-ghost.test.ts` cases.
   - `bun test packages/omo-senpi/src/components/memory` — 1182/1182 pass (172 files).
   - `bunx tsgo --noEmit -p packages/omo-senpi/tsconfig.json` — clean.
   - `node packages/omo-senpi/scripts/qa/drive.mjs --self-test` — SELF-TEST OK (driver harness).
   - `bun run test:senpi` — see `senpi-gate.log` (package gate: build + stage + typecheck + tests).

2. **Patched reconcile driven against a byte-copy of the real wedged state** (`replica-drive.mts`,
   result `replica-drive-result.json`): `active.lock` restored from the pre-repair backup of
   `sisyphuslabs-d5fbf349` (launcher pid dead since 2026-08-18), `runs/reflection-run-1` (retired
   2026-08-13 merged dream) and `completions/` copied byte-for-byte, plus a small synthetic
   pending run. Observed: `reconcileReflectionRuns` returned exactly
   `[{ runId: "reflection-run-1", outcome: "failed", ghostReclaim: true }]`, promoted and launched
   the pending `reflection-run-2`, left every retired artifact byte-identical (sha256 of
   ledger/final/prelaunch), did not move the memory repo HEAD, and a second pass was a clean
   no-op.

3. **Live fleet repair on mengmotaHost** (`fleet-repair-receipt.json`,
   `post-repair-fleet-state.json`): 26 wedged identities repaired (ghost active.lock, oversized
   pending.json, orphan tmp files, dead scheduler locks, ghost worktrees/branches) with pid
   liveness + process-identity checks, zero errors, 6.7 MB backup at
   `~/.omo/wedge-backup-20260908`. Post-repair, the unmodified runtime (bundle with only the
   run-id mint fix) drained the backlog itself: `sisyphuslabs-d5fbf349` went from
   ~31834 advisory-breaching system tokens to ~2532, and an automatic idle-origin dream
   (`reflection-run-14`, outcome merged, 2026-09-08T03:59Z) completed through the normal worker
   pipeline — the first successful dream since 2026-08-13.

## Why this is enough

- The defect was a state-machine blind spot (reconcile could not see a wedged active reservation
  whose run dir belongs to a retired generation); the replica drive exercises exactly that state
  on real data and proves reclaim + promotion + artifact preservation end to end.
- The new tests pin the classification boundaries (terminal retired dir, older ledger,
  ghost-owned prelaunch, missing identity, live-launcher gate, generation slack).
- The live repair + idle dream prove the production trigger path (idle origin through the real
  desktop runtime), not just the reconcile unit.

## Omitted / residuals

- `omo -p "/dream"` headless smoke hit a pre-existing lifecycle error (`extension ctx is stale
  after session replacement or reload`) in bind-time reconcile on the print-mode path —
  unrelated to this change (reproduces on the unmodified runtime); recorded as a follow-up.
  The interactive desktop path performed the same bind reconcile and completed dream run-14.
- Pending-payload growth (the 183 MB pending.json that amplified the wedge) is a follow-up:
  promotion caps are untouched by design in this PR.
- Raw transcripts and memory repo contents are not copied into this directory; only hashes,
  sizes, and outcome records are cited (privacy).

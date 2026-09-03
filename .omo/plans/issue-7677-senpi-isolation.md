# Issue #7677: Senpi QA isolation hardening

Base: `origin/dev` at `cca216272585a55aeb94a864d3b0bed704dd40f9`.
Branch: `fix/7677-senpi-isolation`.
Reference: read-only `omo-pr7500-postmerge-cleanup` at `f4a4fc8613f1f1153f27ca3b35de736abf05ca4d`; port source behavior only, never history or stale evidence.

## Decisions

- Keep the implementation inside `packages/omo-senpi/scripts/qa/`; repository evidence and this plan are the only non-QA additions.
- Split bounded stable file reads into `isolation-file-readers.mjs`, isolation snapshots/verdicts into `isolation-state.mjs`, and keep `drive.mjs` as orchestration.
- Preserve current-dev transient tree-entry handling and normalized volatile settings stamps while making access/I/O failures explicit and fail-closed.
- Define the verdict as the sorted set union of direct protected changes, observed protected changes, and observed nonvolatile changes. Exclude only canonical `sessions/`, `cache/`, `logs/`, and `*.log` observations.
- Bound recursive observation by files, entries, and bytes. Report completeness, truncation, errors, and bytes without claiming complete whole-home coverage.
- Use descriptor/chunk reads and bigint identity/size/timestamp windows to detect replacement and mutation races. Preserve primary errors over diagnostic/close errors; report close errors only when no primary exists.
- Set both `HOME` and `USERPROFILE` for child QA. Emit no credential contents or protected hashes in evidence.
- Preserve all `script/**`, package manifests, lock/pins/patches, generated bundles, compile runtime, OAuth behavior, hooks fixtures, and unrelated tests byte-for-byte relative to this base.

## Granular task state

- [x] Create isolated worktree/branch, fetch and fast-forward to latest `origin/dev`.
- [x] Read applicable root/package/QA `AGENTS.md`, Senpi QA skill, current QA source/tests, and read-only reference source.
- [x] Restore the three checkout-induced CRLF artifact contents without staging them (raw blob hashes match HEAD; local index flags hide Git's inconsistent LF clean-filter report).
- [x] RED: add focused isolation contract tests for canonical verdicts, error semantics, limits, races, error precedence, path canonicalization, and child HOME/USERPROFILE.
- [x] Run focused tests and record the deterministic 0-pass/2-fail missing-module result.
- [x] GREEN: add bounded stable file readers and isolation state module; integrate them into `drive.mjs`.
- [x] GREEN: update current `task-13.test.ts` contracts while preserving current-dev transient-entry and settings-stamp behavior.
- [x] Run blocker/isolation/task-13 focused tests and driver self-test (40 pass, 0 fail; self-test OK).
- [x] Resolve a new evidence directory with the repository resolver and run the real isolated Senpi driver (PASS).
- [x] Run one serialized `bun run test:senpi`, package typecheck, exact scoped Biome check, LSP/no-excuse, and extension freshness.
- [x] Complete JSON/secret/diff checks and prove zero diff for `script/**`, manifests/pins/patches/compile/OAuth/generated/unrelated surfaces.
- [x] Record sanitized evidence explaining issue #7677 and why closed PR #7540 was replaced rather than reopened.
- [x] Complete final measurement/review; only attribution commit and clean-state proof remain.

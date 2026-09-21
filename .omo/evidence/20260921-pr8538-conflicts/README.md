# PR 8538 dev integration

PR parent: f277285f6. Integrated dev parent: 8fd4c013f.

Only changes.md conflicted: both branches prepended independent entries.
Resolution preserves the complete upstream September 21 frontend entry followed
by the complete PR September 20 native-build entry. No migration implementation
was manually changed. Clean upstream merges include beta.80 release metadata and
the exact Senpi 2026.9.20 dependency upgrade.

## Verification

- Fresh task-owned worktree; frozen Bun 1.4.0 install with --ignore-scripts.
  Installed engine version checked as 2026.9.20. No install-time tracked changes.
- Existing Terser 5.51.2 supplied only by a temporary node_modules symlink because
  the build tooling does not declare it. No manifest or lockfile workaround.
- Complete native + direct native-build suite: 436 pass, 0 fail, 1420 assertions,
  45 files, 44.29 seconds. Includes real default build and git-status preservation.
- Scoped native tsc: the same six existing node:sqlite errors in three tests.
- Markdown LSP unavailable; conflict diff and git diff --check are clean.
- Actual darwin-arm64 binary build: exit 0, 110986226 bytes, 751 embedded sidecars,
  output /tmp/omo-pr8538-conflict-build/omo-darwin-arm64.
- Isolated real Node and compiled consumer QA: 17 scenarios each, PASS.
- Native ModelRegistry provider oracle: 12 cases, PASS.
- Native restricted-agent consumer matrix: 72 cases, PASS.
- No live user configuration was changed; all migration QA used disposable fixtures.

Updated Node/compiled receipts and reproducible verifier scripts are under
../20260920-pr8538-remediation/. Provider and agent receipts are byte-identical
to the previously committed passing results.

This integration uses a merge commit and a normal push. It does not merge the PR,
rewrite history, request reviewers, or mention anyone.

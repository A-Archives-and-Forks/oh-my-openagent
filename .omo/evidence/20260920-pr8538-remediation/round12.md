# Resolve defaults against the complete proposed catalog

The eleventh review reproduced a new provider whose catalog omitted the selected
deployment. The new regression was observed RED before removing the existing-only
shortcut.

Every newly selected default now goes through the actual native ModelRuntime
composer using modelsNext, not the old on-disk catalog. The public SDK accepts a
path, so a private mkdtemp directory and mode-0600 catalog file hold the proposal;
finally removes them on success or failure. No migration target is used as a trial
file. Credentials remain empty/read-only and model networking is disabled.
Unresolved defaults preserve prior settings and receive a field-only warning.

Package-copy tests explicitly link the declared pinned engine dependency instead
of relying on ambient module resolution. No assertions were weakened.

## Verification

- Exact Bun 1.4.0 native plus direct native-build suite: 436 pass, 0 fail,
  1420 assertions, 45 files.
- Native tsc: only the same six existing node:sqlite errors.
- Actual darwin-arm64 build: exit 0, 110920178 bytes, 751 sidecars.
- Node and compiled launchers pass full verify.mjs and the 72-agent matrix.
- Provider QA passes 12 cases: each launcher tests fresh valid, fresh missing,
  existing matching, existing missing, disabled and globally disabled catalogs.
- Every written pair resolves through independent native ModelRegistry.find.
- Every case first previews. TMPDIR/TMP/TEMP point inside the fixture, so recursive
  path/byte snapshots verify both unchanged targets and complete scratch cleanup.
- Current full receipt: provider-alias-qa.json. All fixtures were removed.
- The eleventh review worktree was removed without tracked changes.

```bash
REVIEW_COMPILED_BINARY=/tmp/omo-pr8538-round12-build/omo-darwin-arm64 \
  node .omo/evidence/20260920-pr8538-remediation/verify-provider-aliases.mjs
```

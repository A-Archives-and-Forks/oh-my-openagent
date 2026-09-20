# Default selection after preserved-catalog reconciliation

The tenth review found that a preserved destination containing only a different
deployment could leave a newly written default unresolved. Missing-model and
disabled-provider cases were observed RED (two existing cases passed).

New default selection now follows provider reconciliation. For a preserved
destination, the declared engine SDK's actual synchronous ModelRuntime catalog
must resolve the requested model. A missing or disabled model leaves prior settings
unchanged with a field-only manual-review warning. Globally disabled providers are
also withheld. Existing complete/partial default choices remain untouched.

The lookup is a documented lazy engine-SDK boundary. It receives an empty read-only
credential store, disables model-network refresh and reads only the existing
models file for catalog composition. It writes no candidate configuration or cache.

## Verification

- Exact Bun 1.4.0 native plus direct native-build suite: 435 pass, 0 fail,
  1411 assertions, 45 files.
- Native tsc: only the same six existing node:sqlite errors.
- Actual darwin-arm64 build: exit 0, 110920178 bytes, 751 sidecars.
- Both launchers pass full verify.mjs and the 72-case restricted-agent matrix.
- Updated provider QA passes 10 cases: Node/compiled x new, matching, missing,
  provider-disabled and globally-disabled destinations. Every written pair resolves
  through independent native ModelRegistry.find; withheld pairs preserve prior settings.
- Each case first executes --dry-run. Recursive snapshots of every fixture path
  and file byte remain identical, including the lazy-SDK catalog path.
- Full current receipt: provider-alias-qa.json. All temporary fixtures were removed.
- The tenth review worktree was removed after confirming its only tracked difference
  was checkout-induced line-ending normalization.

```bash
REVIEW_COMPILED_BINARY=/tmp/omo-pr8538-round11-build/omo-darwin-arm64 \
  node .omo/evidence/20260920-pr8538-remediation/verify-provider-aliases.mjs
```

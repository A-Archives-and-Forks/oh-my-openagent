# Legacy shared-config agent translation

The seventh review found legacy agents bypassed conversion and could abort an
otherwise valid migration when permission fields reached the native schema.
Six legacy cases were observed failing before correction.

Legacy agents now use the same collector as inline/Markdown definitions, including
restriction tracking and all global/profile conflict checks. Supported fields are
checked with the canonical native agent schema and retain their raw values until
combined normalization, preserving model chains and reasoning aliases. Unsupported
fields are dropped with path-only warnings. Other shared configuration still moves.

## Verification

- Exact Bun 1.4.0 native suite: 420 pass, 0 fail, 1340 assertions, 44 files.
- Native tsc: only the same six existing node:sqlite errors.
- Actual darwin-arm64 build: exit 0, 110870642 bytes, 751 sidecars.
- Both Node and compiled launchers pass the full verify.mjs harness.
- Native loadOmoConfig matrix: 72 passing cases, adding legacy sources to all
  four layer positions and enabled/disabled/new destinations on both launchers.
- Positive legacy regressions cover permission/permissions, settings continuation,
  model chains, reasoning normalization, disabled state and secret-safe warnings.
- Updated full receipt: restricted-agent-qa.json; fixtures were removed.
- The seventh review worktree was removed without tracked changes.

```bash
REVIEW_COMPILED_BINARY=/tmp/omo-pr8538-round8-build/omo-darwin-arm64 \
  /tmp/omo-pr8538-tools/node_modules/@oven/bun-darwin-aarch64/bin/bun \
  .omo/evidence/20260920-pr8538-remediation/verify-restricted-agents.mjs
```

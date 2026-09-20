# Restricted-agent conflict correction after 28192dfeb

The fifth review identified one remaining defect: a native agent with explicit
disable:false could keep that value while receiving a restricted source prompt,
and the warning incorrectly claimed the agent was disabled.

Both inline and Markdown conflict regressions were observed failing first.
Collection now carries restricted-agent names separately. Before merge, an
explicitly enabled destination causes the entire conflicting source agent to be
skipped. Existing fields remain intact, compatible agents still migrate, and the
warning accurately describes the preserved enabled destination and manual review.
Other restricted imports remain disabled.

## Verification

- Exact Bun 1.4.0 suite: 408 pass, 0 fail, 1257 assertions across 44 files.
- Native tsc: only the same six existing node:sqlite errors.
- Rebuilt real darwin-arm64 binary: 110870642 bytes, 751 sidecars, exit 0.
- Existing verify.mjs passed through Node and the new compiled binary.
- verify-restricted-agents.mjs passed 12 real-launcher/native-consumer cases:
  Node/compiled x inline/Markdown x enabled/disabled/new destination.
- The native loadOmoConfig(harness:senpi) result has no imported prompt in the
  enabled conflict case, retains disable:false and existing description, and
  keeps the disabled/new cases disabled with their imported prompt.
- Complete receipt: restricted-agent-qa.json. All fixtures were removed.

Reproduce from the worktree:

```bash
REVIEW_COMPILED_BINARY=/tmp/omo-pr8538-round6-build/omo-darwin-arm64 \
  /tmp/omo-pr8538-tools/node_modules/@oven/bun-darwin-aarch64/bin/bun \
  .omo/evidence/20260920-pr8538-remediation/verify-restricted-agents.mjs
```

The fifth review worktree was removed after confirming that its only tracked
difference was checkout-induced line-ending normalization. No shared source or
real credential store was changed.

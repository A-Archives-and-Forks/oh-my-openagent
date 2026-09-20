# Global harness/profile restricted-agent guard

The sixth review found that the top-level guard missed `[senpi]` and profile
overrides. The extended regression matrix reproduced six failures, while the two
top-level cases remained green.

The same whole-agent skip now applies when explicit disable:false exists in any
global base, global [senpi], profile base or profile [senpi] agent definition.
Every profile is checked, including inactive and non-first profiles; no existing
layer is changed. Compatible agents continue to migrate.

## Verification

- Exact Bun 1.4.0 native suite: 414 pass, 0 fail, 1299 assertions, 44 files.
- Native tsc: only the same six existing node:sqlite errors.
- Actual darwin-arm64 binary rebuilt with exit 0: 110870642 bytes, 751 sidecars.
- Full verify.mjs passed independently through Node and compiled launchers.
- Restricted-agent QA passed 48 combinations through native loadOmoConfig:
  Node/compiled x inline/Markdown x four layer positions x enabled/disabled/new.
- Enabled conflicts retain the existing state and have no imported prompt;
  disabled/new cases retain a disabled imported prompt.
- The profile fixtures include an unrelated first profile and activate the tested
  profile only when reading through the consumer, not during migration.
- Complete updated receipt: restricted-agent-qa.json. Temporary fixtures were removed.
- The sixth review worktree was removed without tracked changes.

```bash
REVIEW_COMPILED_BINARY=/tmp/omo-pr8538-round7-build/omo-darwin-arm64 \
  /tmp/omo-pr8538-tools/node_modules/@oven/bun-darwin-aarch64/bin/bun \
  .omo/evidence/20260920-pr8538-remediation/verify-restricted-agents.mjs
```

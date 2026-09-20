# Provider aliases back the saved default model

The ninth review found defaults resolved azure to azure-openai-responses while the
provider definition remained under azure. Both fresh and conflicting-destination
regressions were observed failing before correction.

Provider definitions now use the same destination resolver as defaults for lookup,
validation and storage. Existing destination definitions remain intact, differing
incoming definitions receive a manual-review warning, and equal definitions remain
warning-free. The second run keeps report bytes and backup counts unchanged.

## Verification

- Exact Bun 1.4.0 native plus direct native-build suite: 432 pass, 0 fail,
  1380 assertions, 45 files.
- Native tsc: only the same six existing node:sqlite errors.
- Actual darwin-arm64 binary rebuilt: exit 0, 110870642 bytes, 751 sidecars.
- Node and compiled launchers both pass the complete verify.mjs harness.
- verify-provider-aliases.mjs passes four native ModelConfig consumer cases:
  Node/compiled x fresh/existing destination. getProvider(defaultProvider) finds
  the definition and requested model; existing endpoint/catalog bytes survive
  conflicts and receive a warning.
- The 72-case restricted-agent matrix also passes against the new binary.
- Full receipts: provider-alias-qa.json, restricted-agent-qa.json,
  consumer-qa.json and compiled-consumer-qa.json. All fixtures were removed.
- The ninth review worktree was removed after its only tracked difference was
  verified to be checkout-induced line-ending normalization.

```bash
REVIEW_COMPILED_BINARY=/tmp/omo-pr8538-round10-build/omo-darwin-arm64 \
  node .omo/evidence/20260920-pr8538-remediation/verify-provider-aliases.mjs
```

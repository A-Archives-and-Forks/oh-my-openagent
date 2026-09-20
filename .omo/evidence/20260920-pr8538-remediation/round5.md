# Corrections following the review of 844f6650d

All nine initial regression cases failed before the fix. The additional
missing-provider-options warning case was also observed failing before correction.

## Changes

- Existing and planned models documents use the pinned native models schema.
  Invalid existing documents stop before any writes. Invalid translated providers
  are skipped with field-only diagnostics; valid providers still migrate and load
  through Senpi ModelConfig.
- Unsupported provider/model fields are collected before API, endpoint or expression
  early returns, including absent options and retained destination providers.
- Empty MCP maps do not trigger the optional validator import. A copied source-only
  launcher with its generated bundle removed still imports credentials.
- Typed Markdown parse failures are handled per file, with source backup and
  path-only warnings. Other configuration continues; unrelated I/O errors are not
  silently suppressed.
- The compiled top-level error boundary matches the npm launcher's concise stderr
  and nonzero exit instead of dumping the embedded source frame.

## Evidence

- Exact Bun 1.4.0 native suite: 406 pass, 0 fail, 1245 assertions across 44 files.
- Native tsc: the same six existing node:sqlite errors; no new errors.
- The actual darwin-arm64 binary rebuilt successfully: 110870642 bytes, 751 sidecars.
- Both the compiled binary and Node launcher passed verify.mjs, now including
  native ModelConfig acceptance, invalid-provider rejection, malformed Markdown
  continuation, exhaustive provider warnings and byte-for-byte stderr parity.
- Complete current receipts: consumer-qa.json and compiled-consumer-qa.json.
- Earlier credential, consent, source layering, restrictions, backups, report
  refresh and no-op cases remain in the passing suite and actual CLI harness.
- No real HOME, credentials or provider service was used.

The completed fourth review worktree was removed. Its only tracked difference
was checkout-induced line-ending normalization, confirmed by an empty
git diff --ignore-space-at-eol with exit 0; the original implementation copy was
not touched.

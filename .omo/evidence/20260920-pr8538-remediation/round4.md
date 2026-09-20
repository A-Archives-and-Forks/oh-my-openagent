# Corrections following the review of 5695fc209

The fresh review closed the previous three findings and reproduced five further
source-compatibility issues. All probes used disposable HOME/XDG/agent directories.

## Source contracts

OpenCode's source loads config.json, opencode.json and opencode.jsonc in that order
with deep merge. Its agent loader scans `{agent,agents}/**/*.md` with symlink support,
and configuration assembly merges Markdown agents over inline definitions.

References inspected on 2026-09-20:

- https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/config/config.ts
- https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/config/agent.ts
- https://opencode.ai/docs/config/

The initially truncated config.ts fetch was replaced with the complete GitHub
content API response (27747 bytes), rather than treating the missing tail as absence.
No OpenCode process or source-side config writer was executed.

## Corrections and regressions

- Shared global loader merges all three config files and both TUI variants,
  with JSONC-last precedence and all contributing paths in the backup manifest.
- Existing and planned MCP documents use Senpi's actual full schema and endpoint
  validator. Both setup and migrate stop before credential/settings writes when
  an enabled HTTP server lacks a URL or a header has the wrong type.
- Raw `${VAR}` / `${VAR:-fallback}` MCP literals require manual review before
  supported `{env:VAR}` translation, preventing unintended variable expansion.
- Recursive/symlinked Markdown agents retain relative names and source backups.
  Inline fields are retained for a same-name Markdown agent; unrepresentable
  inline restrictions cannot disappear and enable that agent.
- Unhandled root/TUI/provider/model options get path-only warnings. Unsupported
  default-model expressions also receive a warning without resolving their values.

Observed RED: 0 pass, 11 fail for the initial compatibility cases. Two additional
agent-composition cases and one model-expression warning case were separately
observed failing before correction.

## Final verification

- Exact Bun 1.4.0 native suite: 396 pass, 0 fail, 1200 assertions.
- Native tsc: only the same six preexisting node:sqlite diagnostics.
- Real darwin-arm64 binary rebuilt successfully: 110854130 bytes, 751 sidecars.
- Both the binary and Node launcher passed the updated verify.mjs, including
  layered config precedence, native MCP consumption, rejected schema-invalid
  documents, literal-expression rejection, nested agents, source backups and
  unsupported-option reports.
- Full source/compiled receipts are consumer-qa.json and compiled-consumer-qa.json.
- Prior credential, consent, report, permission, keybinding and old-state recovery
  scenarios remain in the same passing suite and real-CLI harness.

MCP imports load the generated validator bundle lazily; ordinary CLI/help and
credential-only setup still work without it in a source checkout. Package builds
and affected tests generate the bundle before use. No dependency pin or lockfile
was changed.

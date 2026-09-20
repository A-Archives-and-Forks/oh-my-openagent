# PR 8538 remediation: final integration verification

This receipt supersedes intermediate checkpoints under `core/` and `launcher/`.
Baseline: 9a6028354. No real credential store or provider service was used.

## Automated tests

Using exact-pinned Bun 1.4.0 with its bin directory first in PATH:

```text
436 pass
0 fail
1420 expect() calls
Ran 436 tests across 45 files. [42.54s]
```

Command: from an isolated test cwd without unrelated adapter preloads,
`bun test <worktree>/packages/omo-native/test <worktree>/script/build-omo-native.test.ts`.
This includes the complete native suite plus nine direct native-build tests.

Regressions were observed failing before fixes: malformed-target partial writes,
OAuth aliases, expression translation, content-copy rollback, compiled JSON
resource loading, dry-run state adoption, leader chords, masked configuration,
diagnostic secret leakage, backup-source omission, invalid permissions, unknown
provider APIs, and recovery of unsupported output from the old migration.
The subsequent review's three remaining findings were reproduced and corrected:
literal credential resolution, consent-time target changes, and stale durable
warnings. See `round3.md` for RED/GREEN and consumer evidence.
`round4.md` records the next review's source-precedence, complete MCP validation,
literal MCP expression, recursive-agent, and unsupported-field corrections.
`round5.md` covers native models validation, exhaustive provider warnings, empty
MCP setup, per-file malformed Markdown handling and compiled error parity.
`round6.md` covers restricted-source conflicts with explicitly enabled destination
agents, verified through native loadOmoConfig and both actual launchers.
`round7.md` extends that guard and native-consumer verification to `[senpi]`
and every profile's base and `[senpi]` layers.
`round8.md` applies the same translation and safety guard to legacy shared-config
agents, preserving native-compatible fields and warning on unsupported ones.
`round9.md` verifies the default native build preserves tracked ignore rules and
git status. `round10.md` verifies provider aliases resolve consistently between
defaults and imported definitions, including preserved destination conflicts.
`round11.md` defers new defaults until reconciliation and verifies models against
the actual preserved native catalog, without credential access, network or writes.
`round12.md` validates every new default against the complete proposed catalog,
including new providers, using an automatically removed private scratch document.

An intermediate full-suite failure was caused by this change's additional generated
file in `.gitignore`, not by unrelated code. The payload test's exact expected
ignore-file contract was updated to include the generated runtime. The complete
suite then passed in one run; no failing tests were removed, skipped, or weakened.

## Real CLI and consumer QA

`verify.mjs` creates disposable fixtures, invokes the actual entrypoint, asserts the
written data and real downstream behavior, then removes the fixtures in `finally`.
It passed independently against:

- `node packages/omo-native/bin/omo.js`: `consumer-qa.json`.
- The newly built darwin-arm64 executable: `compiled-consumer-qa.json`.

Both receipts cover:

| Scenario | Observed |
| --- | --- |
| setup with aliased credentials and MCP expressions | Mapped auth imported; native MCP loader resolves the environment reference. |
| migrate --help | No engine state or user OMO directory created. |
| migrate --dry-run | Existing config bytes unchanged; no state marker. |
| Existing omo.json and custom engine directory | Correct user file updated; no shadowing omo.jsonc or misplaced config. |
| Existing, Markdown, inline and legacy agents together | All non-conflicting agents retained; restricted agent remains disabled. |
| Root permission shorthand | Actual Senpi permission loader/evaluator returns ask for bash and edit. |
| Provider/model defaults and provider expressions | Existing partial defaults preserved; environment references and upstream model ID retained. |
| Keybinding alternatives, none and leader chord | Native KeybindingsManager matches Ctrl-L; unsupported leader binding not emitted. |
| Nested existing categories | Existing quick plus imported deep both retained. |
| Malformed target MCP | Nonzero exit; no settings or migration marker written. |
| Second migration | Config bytes unchanged. |
| Old marker and masking jsonc | Previously hidden json configuration and omitted agent recovered. |
| Global JSON/JSONC layers and TUI layers | Later JSONC values win while other keys survive; all sources are backed up. |
| Schema-invalid MCP documents | Both commands abort without writing credentials/settings. |
| Literal native MCP variables | Server is reported for manual review, never silently interpolated. |
| Nested agents plus inline restrictions | Relative names, missing fields, restrictions and source backups survive. |
| Unsupported settings/provider options | Path-only warnings include every omitted key tested. |
| Invalid translated models | Invalid providers are skipped; the remaining document loads through native ModelConfig. |
| Malformed Markdown agent | Warned and backed up without blocking other configuration. |
| Invalid CLI arguments | Compiled and Node entrypoints return identical concise diagnostics and exit status. |

The real consumer checks use OmoConfigLayerSchema, Senpi ModelConfig and loadMcpConfig,
SettingsManager plus permission evaluation, and KeybindingsManager. A regression
also loads escaped literal credentials through Senpi resolveConfigValue rather
than treating command-shaped API keys as executable helpers.

## Build

```bash
bun run script/build-omo-binary.ts \
  --target darwin-arm64 \
  --omo-version 5.0.0-review12 \
  --omo-ai-version 5.0.0-0.beta.review12 \
  --out-dir /tmp/omo-pr8538-round12-build
```

Exit 0: built darwin-arm64, 110920178 bytes, 751 embedded sidecar files.
The exact output binary passed the CLI/consumer QA above. The package suite also
built and validated the full native plugin payload.

Direct build-script regressions (`script/build-omo-native.test.ts` and
`script/build-omo-binary.test.ts`) produced 56 pass, 1 existing skip, 1 failure.
The failure is the unchanged sidecar assertion at build-omo-binary.test.ts:479:
`plugin/skills/ast-grep/SKILL.md` is absent from the generated plugin source tree.
This is separate from the corrected native-package `.gitignore` expectation.
No sidecar assertion was removed or weakened. The actual host binary build and
setup/migrate execution still succeeded as recorded above.

## Static-check limitations

- Native tsc: six existing TS2591 diagnostics for node:sqlite in three test files.
  No new migration-runtime, regression-test, or build-helper diagnostics.
- Script typecheck: existing TS2322 at packages/utils/src/runtime/file.ts:35
  (ArrayBuffer | SharedArrayBuffer versus ArrayBuffer).
- LSP returned timeouts for some files; compiler output is recorded rather than
  treating the timeouts as clean diagnostics.

These errors were not suppressed. Dependencies were installed frozen with scripts
disabled. The preexisting undeclared Terser build dependency was supplied only in
the task's node_modules via an isolated terser@5.51.2 installation; no manifest or
lockfile change was made for it. Tests and binary builds used isolated Bun 1.4.0;
the workstation's global Bun was not replaced.

## Scope and remaining limits

Only macOS arm64 binary execution was performed. Windows/Linux executables were
not run. Caught write errors roll back; abrupt process termination is not claimed
to provide a multi-file transaction. Backups include a manifest for manual recovery.
The corrected npm lifecycle oracle and its negative control are in `postinstall.md`.

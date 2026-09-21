## Setup migration review corrections

OAuth re-auth guidance now maps source aliases and excludes gateway/unknown IDs
from executable login advice. MCP environment references translate to `${VAR}`;
file references and unsupported command expressions are reported for manual
review rather than copied as literal credentials. Malformed target MCP objects
are checked with Senpi's complete schema and endpoint validator, as is the planned
document, before credential writes. Preexisting native `${VAR}` syntax in OpenCode
MCP values requires manual review rather than being reinterpreted. A caught content-copy failure restores
previous credential/MCP bytes and removes newly copied skill directories.
Imported credential strings are escaped as native literals, so `$` and a leading
`!` cannot become interpolation or a command. Auth/MCP/AGENTS targets are compared
with the planned bytes after consent; a concurrent edit aborts before any writes.

## omo migrate - the opencode codemod

`omo migrate` previews unless `--yes` explicitly permits writes. Both npm and compiled
launchers use the same setup/migrate dispatcher; help and dry-run bypass legacy-state
adoption. A literal lazy import keeps ordinary commands independent of the generated
schema/YAML runtime; MCP imports also load its validators lazily. Native staging and
binary builds generate the bundle atomically.
Empty source MCP maps do not load that bundle during credential-only setup.
The compiled top-level error boundary uses the npm launcher's concise error and
exit-status contract instead of exposing Bun's embedded-source stack frames.

Migration treats default provider/model as a pair, translates permission shorthand,
environment references and upstream model IDs, and converts key alternatives/`none`.
Provider definitions use the same destination alias as defaults. A differing
definition at that destination is preserved with a manual-review warning; equal
definitions remain no-ops on rerun.
Unsupported chords, config expressions and settings produce manual-review warnings.
Restricted Markdown/inline/legacy agents remain disabled pending review; existing agent and
category leaves take precedence over imported values.
If an existing agent explicitly has `disable:false`, a restricted source agent is
skipped in its entirety instead of importing its prompt into that enabled agent.
Its manual-review warning describes the preserved destination, not a disabled state.
The guard checks base and `[senpi]` agent settings in the global config and every
profile, including profiles that are not active during migration.
Legacy shared-config agents use the same translator and conflict guard, rather
than bypassing them through dictionary copying. Native-schema-compatible fields
(including model chains and reasoning aliases) survive; unsupported agent fields
are dropped with path-only warnings without blocking other configuration.

Shared config uses omo-config-core path selection, recursive merge and schema validation,
independently of the engine directory. Versioned state re-evaluates old markers and recovers
config hidden by the earlier `.json`/`.jsonc` behavior. All targets are read before writing;
caught write failures restore previous bytes. Backups include an original-path manifest,
and `opencode-migration-report.json` retains warnings and the backup directory. Diagnostics
identify conflicting fields without serializing their values.
Each run re-evaluates unresolved warnings. The durable report refreshes when those
warnings change, retains the last applied action rows on no-op runs, and does not
create backups solely for volatile paths or unchanged merge leaves.

Setup and migration share OpenCode's global read precedence: `config.json`,
`opencode.json`, then `opencode.jsonc`, recursively merged. TUI JSON and JSONC are
merged likewise. Agent discovery includes nested/symlinked directories, preserves
relative names, and backs up every discovered Markdown source. Inline agent fields
fill missing Markdown fields without dropping restrictions. Unhandled root settings
and provider/model options receive path-only manual-review warnings.
Provider warning paths are collected before all translation early returns and
even when a destination provider already exists. Existing and planned model
documents use Senpi's pinned models schema; invalid translated providers are
skipped with field-only warnings while valid providers still migrate. Malformed
Markdown frontmatter is warned and skipped per file, as in OpenCode, while its
readable original remains in the backup.

## omo setup inherits opencode content, and names every skipped OAuth provider

`omo setup` now reads the global opencode config dir beyond credentials: `mcp` servers translate
into `<agentDir>/mcp.json` (`local`->`stdio` with command/args/env/startupTimeoutMs, `remote`->`http`,
existing server names and unknown server shapes are skipped, never clobbered, existing files backed
up as `.bak-<ts>`), `skills/<name>/` directories copy in (skip-existing), and a global `AGENTS.md`
carries over when the agent dir has none. Hosted gateways (opencode, opencode-go, zai-coding-plan)
report as `skipped-gateway`, distinct from genuinely unmapped ids, and every skipped OAuth provider
prints its own engine-convention guidance line (`Run '/login <provider>' to re-authenticate.`)
instead of the generic auth hint. JSONC sources parse through a small dependency-free
comment/trailing-comma tolerant reader (`bin/lib/jsonc-lite.js`). Everything stays consent-gated
(`--yes` or one combined prompt) and idempotent across runs.

## omo daemon reaches the launcher, the compiled entry and doctor

`omo daemon attach <launch args>` continues as a normal launch whose environment points the engine at
the shared socket. `omo doctor` gains one `INFO Daemon:` line (not running / pid, instance, engine,
sessions, zombies) - never a FAIL, since a machine without a daemon is healthy. The compiled binary
reaches the engine's host CLI by re-running ITSELF with `host ...` (an early command that goes to the
engine untouched); spawning a node path there would re-enter omo and leave a phantom session.

## omo daemon - the operator's view of the shared engine host

`omo daemon run|attach|status|stop|handoff` (`bin/lib/daemon.js`) wraps the engine's `senpi host`.
The wrapper owns three things and deliberately nothing else: the launch spec under the plugin root
is the argv source, `omo.json` `task.host_engine_policy` / `task.host_idle_exit_ms` is where the
policy comes from, and every outcome has a named exit code (2 usage, 3 not running, 4 win32,
5 the engine refused) so a script never parses prose. `run` and `attach` are omo's words for the
engine's `ensure`; `status` and `stop` do not need a launch spec and still work without one.

## 2026-09-17 — stamp the engine build epoch into compiled binaries

`build-info.ts` derives `EngineBuildStamp { scheme, epoch, sha7, source }` from omob
`OmoBuildInfo.engine` (commit + committedAt) or, for a release compile, from the pinned
`@code-yeongyu/senpi` package.json (`gitHead` plus `committedAt` / `gitCommittedAt` /
`gitHeadCommittedAt`). A missing timestamp is scheme `nodef` with epoch 0 — never `Date.now()`.

`compile-entry.ts` `versionLine` records which path the build took: omob `--version` includes
`+<epoch>.<sha7> (scheme epoch)`; a define-less release prints `scheme nodef`.

`script/engine-build-defines.ts` turns an epoch stamp into bun `--define SENPI_BUILD_EPOCH=…`
`--define SENPI_BUILD_SHA7="…"` and omits both for `nodef`. `script/build-omo-binary.ts` passes
those defines on every `bun build --compile` that has a stamp; `build-omob.ts` inherits them
through `--build-info`. Correctness of handoff does not depend on the define: a missing define
is scheme `nodef`, which per I2 never initiates a handoff.

Refs #8415.

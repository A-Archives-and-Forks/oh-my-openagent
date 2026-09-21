## Setup migration review corrections

OAuth re-auth guidance now maps source aliases and excludes gateway/unknown IDs
from executable login advice. MCP environment references translate to `${VAR}`;
file references and unsupported command expressions are reported for manual
review rather than copied as literal credentials. Malformed target MCP objects
stop setup before credential writes. A caught content-copy failure restores
previous credential/MCP bytes and removes newly copied skill directories.
Evidence: `.omo/evidence/20260920-pr8538-remediation/setup/`.

## omo migrate - the opencode codemod

`omo migrate [--dry-run|--yes]` translates an existing global opencode setup into omo-native state in
one pass: `model`/`permission` into `settings.json` (never overwriting keys the user already has),
custom `provider` blocks into `models.json` (senpi's array shape, limits -> contextWindow/maxTokens,
npm package -> `api` mapping with manual-review notes when unknown), the `mcp` block into `mcp.json`,
`tui.json` keybinds into `keybindings.json` (best-effort id map; unmatched ids are reported, and
leader-key setups are named as unmappable), agent markdown into `omo.jsonc` `agents`, and the shared
omo schema keys (categories/agents/task/teams/codegraph) out of `oh-my-openagent.json(c)` into
`omo.jsonc`. Sources and prior targets are backed up under `migration-backup-<ts>/`, unmappable keys
are printed as `dropped-with-warning` and written to `migration-notes.md`, and a state marker makes
re-runs idempotent. `--dry-run` prints the full plan without touching a single file.

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

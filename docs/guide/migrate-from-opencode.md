# Migrating from opencode to omo (senpi edition)

This guide moves an existing opencode setup (with or without the oh-my-openagent plugin) onto omo
native — the standalone senpi-based edition (`npm i -g omo-ai@beta`). It is written for users who
have customized opencode and want their setup to survive the move.

## The short version

```bash
npm i -g omo-ai@beta
omo setup            # detects opencode, shows a plan, asks before writing
omo setup --yes      # non-interactive: import API credentials + content
omo migrate --dry-run  # plan the full config translation without writing
omo migrate --yes      # translate settings/models/mcp/keybinds/agents/omo config
```

Preview before applying. `omo migrate` requires `--yes` to write; `--help` and
`--dry-run` are read-only. Existing values take precedence, and unsupported settings
are reported for manual review. Backups preserve files that existed before a write.

## What moves automatically

| opencode | omo native | How |
|---|---|---|
| API-key credentials (`~/.local/share/opencode/auth.json`) | `<agentDir>/auth.json` | `omo setup` — `api`→`api_key`, common provider ids remapped; never overwrites existing entries |
| MCP servers (`mcp` in `opencode.json`) | `<agentDir>/mcp.json` | `omo setup` / `omo migrate` — `local`→`stdio`, `remote`→`http`, key renames |
| Skills (`~/.config/opencode/skills/`) | `<agentDir>/skills/` | `omo setup` — copied verbatim (same Agent Skills standard), skip-existing |
| `AGENTS.md` rules | `<agentDir>/AGENTS.md` (and project files keep working as-is) | `omo setup` — same convention on both sides |
| `model` default | `defaultProvider` + `defaultModel` in `settings.json` | `omo migrate` — treated as a pair; existing choices are preserved |
| `permission` rules | `permission` in `settings.json` | `omo migrate` — includes root `ask`/`allow`/`deny` shorthand |
| Custom providers (`provider.*`) | `models.json` | `omo migrate` — supported APIs, upstream model IDs and context/output limits; unsupported definitions need review |
| omo plugin settings (`oh-my-openagent.json`) | Existing user `omo.json`/`omo.jsonc` | `omo migrate` — supported shared schema keys, merged without overwriting existing leaves |
| Custom agents (Markdown and inline definitions) | User OMO config `agents` | `omo migrate` — supported fields; unrepresentable restrictions require manual review |
| Keybinds (`tui.json`) | `keybindings.json` | `omo migrate` — supported IDs, comma alternatives and `none`; leader/chord bindings need review |

## What needs you

- **OAuth / subscription logins are never imported** (token shapes and clients differ per provider).
  `omo setup` maps recognized provider IDs before printing `Run '/login <provider>' to re-authenticate.`
  Run `omo`, then the suggested command. Unknown providers and hosted gateways do not receive a
  potentially invalid login command.
- **Hosted gateway keys** (opencode Zen / opencode-go / zai-coding-plan) authenticate opencode's own
  gateway, not the vendor — they report as `skipped-gateway`. Add the equivalent provider directly.
- **MCP servers with OAuth** re-login on first use (`/mcp login <name>`).
- **Keybinds with no senpi equivalent** (the leader key, agent cycling, `@mention` flows) are
  reported as unmatched/unmappable rather than silently dropped.
- **Config expressions**: supported `{env:NAME}` references become native environment references,
  without reading their secret values. `{file:...}` expressions require manual translation.
- **Agent restrictions**: review any unsupported permission policy before enabling the migrated
  agent; it must not become unrestricted just because its source restriction has no equivalent.

## What does not move (yet)

- **Session history** — this command does not translate sessions; start fresh, or keep
  opencode installed for reading old sessions (both tools can coexist).
- **opencode plugins** — the plugin API differs from senpi extensions; plugins must be ported or
  replaced. omo's own feature set is built into the senpi edition already.
- **Some omo feature flags** (tmux panes, hook-level toggles, sisyphus planner options) — reported
  as `manual-review` and listed in `<agentDir>/opencode-migration-report.json`.

## Safety: backups and rollback

- `omo migrate --dry-run` previews the translation and writes nothing.
- Migration validates the planned configuration before applying it. Existing target files and
  migration sources are backed up under `<agentDir>/migration-backup-<timestamp>-<id>/`.
  Its `manifest.json` maps backup names to original paths and lists newly created files.
  `<agentDir>/opencode-migration-report.json` records warnings and the backup directory,
  including runs that only report unsupported settings. Keep these until you have checked
  the new setup. Reruns refresh unresolved warnings; unchanged reruns retain the last
  applied action rows without creating extra backups.
- `omo setup` backs up an existing `auth.json`/`mcp.json` as `.bak-<timestamp>` before merging.
  If an intended target changes while you answer its consent prompt, setup stops without
  writing so you can preview the new state and try again.
- Caught apply failures roll back earlier writes. Abrupt process termination is not an
  all-or-nothing transaction across multiple files; retain backups for recovery.
- opencode is never modified or uninstalled — your old setup keeps working as-is. To roll back,
  keep using opencode. To undo omo-side state, restore each preexisting file from its backup
  and remove only files that the migration created. Do not delete preexisting settings files:
  they may contain values unrelated to this migration.

## FAQ

**Both opencode and omo installed — do they conflict?**
No. They read different directories (`~/.config/opencode` + `~/.local/share/opencode` vs
`~/.omo/agent`). One known collision: an older globally installed omo (≤ 4.19.4,
opencode edition) may own the `omo` bin. Upgrade or uninstall that package before
installing `omo-ai@beta`; otherwise npm can fail with EEXIST.

**Where does omo keep its state?**
Engine state goes to `~/.omo/agent` (override: `OMO_CODING_AGENT_DIR`). Shared OMO config
remains in `~/.omo/omo.jsonc`, or the existing `~/.omo/omo.json`, independently of that
engine-directory override. The migration targets the global layer, not the current project.

**I run per-project opencode configs.**
This migration covers the global layer. Project `opencode.json` / `.opencode/` dirs keep working
for opencode; senpi's project layer (`.senpi/`) is trust-gated — translate per project with the
same key mapping if you want them native.

**Does the migration phone home or read my secrets?**
No network calls. Credentials are copied locally, never printed (the test suite asserts sentinel
values never appear in output), and sources are read-only.

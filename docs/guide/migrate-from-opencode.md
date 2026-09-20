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

Both tools are backup-first and idempotent: every overwritten file is copied aside first, nothing
is ever silently dropped, and a second run changes nothing.

## What moves automatically

| opencode | omo native | How |
|---|---|---|
| API-key credentials (`~/.local/share/opencode/auth.json`) | `<agentDir>/auth.json` | `omo setup` — `api`→`api_key`, common provider ids remapped; never overwrites existing entries |
| MCP servers (`mcp` in `opencode.json`) | `<agentDir>/mcp.json` | `omo setup` / `omo migrate` — `local`→`stdio`, `remote`→`http`, key renames |
| Skills (`~/.config/opencode/skills/`) | `<agentDir>/skills/` | `omo setup` — copied verbatim (same Agent Skills standard), skip-existing |
| `AGENTS.md` rules | `<agentDir>/AGENTS.md` (and project files keep working as-is) | `omo setup` — same convention on both sides |
| `model` default | `defaultProvider` + `defaultModel` in `settings.json` | `omo migrate` |
| `permission` rules | `permission` in `settings.json` | `omo migrate` — same tri-state, last-match-wins |
| Custom providers (`provider.*`) | `models.json` | `omo migrate` — incl. context/output limits; unknown `npm` packages get a needs-review note |
| omo plugin settings (`oh-my-openagent.json`) | `omo.jsonc` shared keys (`categories`, `agents`, `task`, `teams`, `codegraph`) | `omo migrate` |
| Custom agents (`agents/*.md`) | `omo.jsonc` `agents` | `omo migrate` — description/model/prompt survive |
| Keybinds (`tui.json`) | `keybindings.json` | `omo migrate` — best-effort id map; unmatched ids are listed |

## What needs you

- **OAuth / subscription logins are never imported** (token shapes and clients differ per provider).
  `omo setup` prints one exact line per skipped provider: `Run '/login <provider>' to re-authenticate.`
  Run `omo`, then `/login <provider>` for each.
- **Hosted gateway keys** (opencode Zen / opencode-go / zai-coding-plan) authenticate opencode's own
  gateway, not the vendor — they report as `skipped-gateway`. Add the equivalent provider directly.
- **MCP servers with OAuth** re-login on first use (`/mcp login <name>`).
- **Keybinds with no senpi equivalent** (the leader key, agent cycling, `@mention` flows) are
  reported as unmatched/unmappable rather than silently dropped.

## What does not move (yet)

- **Session history** — opencode's on-disk session store has no public format; start fresh, or keep
  opencode installed for reading old sessions (both tools can coexist).
- **opencode plugins** — the plugin API differs from senpi extensions; plugins must be ported or
  replaced. omo's own feature set is built into the senpi edition already.
- **Some omo feature flags** (tmux panes, hook-level toggles, sisyphus planner options) — reported
  as `dropped-with-warning` and listed in `migration-notes.md` next to the backup.

## Safety: backups and rollback

- `omo migrate --dry-run` prints the complete plan and writes nothing.
- Every written target is first copied to `<agentDir>/migration-backup-<timestamp>/`, together with
  `migration-notes.md` listing anything that did not translate.
- `omo setup` backs up an existing `auth.json`/`mcp.json` as `.bak-<timestamp>` before merging.
- opencode is never modified or uninstalled — your old setup keeps working as-is. To roll back,
  simply keep using opencode; to undo omo-side state, delete the new files (they are all additive).

## FAQ

**Both opencode and omo installed — do they conflict?**
No. They read different directories (`~/.config/opencode` + `~/.local/share/opencode` vs
`~/.omo/agent`). One known collision: if an older omo (≤ 4.19.4, opencode edition) owns
`~/.local/bin/omo`, install the native edition first and let it replace the wrapper — the new
launcher refuses to overwrite a non-omo file, so remove a foreign `omo` binary by hand if needed.

**Where does omo keep its state?**
`~/.omo/agent` (override: `OMO_CODING_AGENT_DIR`). Note the engine resolves the "global" agent dir
from the nearest ancestor `.senpi/agent` or `.omo/agent` directory — run `omo setup`/`omo migrate`
from your home directory (or anywhere without a stray `.senpi/agent` above it) so migrated files
land globally.

**I run per-project opencode configs.**
This migration covers the global layer. Project `opencode.json` / `.opencode/` dirs keep working
for opencode; senpi's project layer (`.senpi/`) is trust-gated — translate per project with the
same key mapping if you want them native.

**Does the migration phone home or read my secrets?**
No network calls. Credentials are copied locally, never printed (the test suite asserts sentinel
values never appear in output), and sources are read-only.

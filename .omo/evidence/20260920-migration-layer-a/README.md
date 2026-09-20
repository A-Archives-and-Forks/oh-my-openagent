# QA evidence — 20260920-migration-layer-a (omo migrate)

## WHAT WAS TESTED
The real launcher (`node packages/omo-native/bin/omo.js migrate`, this branch) against an isolated
sandbox (`sandbox/home` HOME, `sandbox/xdg-config`, `sandbox/xdg-data`, `sandbox/omo-home/agent` as
SENPI_CODING_AGENT_DIR). Fabricated opencode state: `opencode.jsonc` WITH comments covering
model/small_model/autoupdate/permission/custom provider/mcp, `tui.json` keybinds (two mappable, two
unmatched), `agents/reviewer.md` (frontmatter + body), `oh-my-openagent.json` (categories +
opencode-only keys tmux/runtime_fallback). Sequence: `--dry-run`, then `--yes`, then `--yes` again.

## WHAT WAS OBSERVED (dry-run.stdout.txt / run1.stdout.txt / run2.stdout.txt)
- Dry run (exit 0): prints `DRY RUN: no files will be written`; zero files created (verified: 0).
- Run 1 (exit 0): settings/models/mcp/keybindings/agents/omo-config all `migrated`;
  `keybinds-unmatched: leader, theme_list` reported; `dropped-with-warning:
  omo-config.runtime_fallback, omo-config.tmux, settings.autoupdate, settings.small_model` — nothing
  silently dropped; ONE `migration-backup-<ts>/` with the source files + `migration-notes.md`.
- Run 2 (exit 0): every item `already migrated`; no second backup dir.
- Resulting files: `agent/settings.json` (defaultProvider/defaultModel/permission),
  `agent/models.json` (senpi array shape, contextWindow/maxTokens from opencode limits),
  `agent/mcp.json` (`remote`→`http`), `agent/keybindings.json` (snake_case→namespaced ids),
  `omo-home/omo.jsonc` (agents + categories), `agent/opencode-migration-state.json`.
- Unit gate: `bun test packages/omo-native/test` — 336 pass / 0 fail in scope (5 new migrate tests);
  the single failure is the pre-existing bun<1.4 environmental `compile-prebuilds` case.

## WHY IT IS ENOUGH
The real binary ran the full codemod path (read opencode sources → translate → backup → write →
report → marker) across every translation row, with dry-run and idempotency proven by file counts.

## WHAT WAS OMITTED
Dummy values only; no real credentials. TTY consent is not part of `migrate` (it is an explicit
`--dry-run`/`--yes` tool, matching codemod conventions — Tailwind/ng update).

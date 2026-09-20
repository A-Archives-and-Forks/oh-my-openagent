# QA evidence — 20260920-migration-layer-b (omo setup content inheritance)

## WHAT WAS TESTED
The real launcher (`node packages/omo-native/bin/omo.js setup --yes`, this branch) against an isolated
sandbox: `sandbox/home` (HOME), `sandbox/xdg-config` (XDG_CONFIG_HOME), `sandbox/xdg-data`
(XDG_DATA_HOME), `sandbox/agent` (SENPI_CODING_AGENT_DIR). Fabricated opencode state: `auth.json`
(api `kimi-for-coding`, oauth `openai`, gateway `opencode-go` — dummy values), `opencode.jsonc`
WITH comments (model + mcp: one `local` server with environment+timeout, one `remote` server),
`skills/use-railway/SKILL.md`, `AGENTS.md`. Then a second identical run for idempotency.

## WHAT WAS OBSERVED (run1.stdout.txt / run2.stdout.txt)
Run 1 (exit 0): `planned-add: kimi-coding` (id remap), `skipped-oauth: openai`, `skipped-gateway:
opencode-go` (new distinct line), per-provider guidance `Run '/login openai' to re-authenticate.`
(replacing the generic `omo auth` line), `mcp-planned-add: localtools, web` → `mcp-imported: 2`,
`skills-imported: 1`, `agents-md: copied`. Resulting `agent/auth.json` contains ONLY `kimi-coding`
as `api_key`; `agent/mcp.json` holds both servers translated (`local`→`stdio` with
command/args/env/startupTimeoutMs, `remote`→`http`); skills and AGENTS.md copied.
Run 2 (exit 0): everything `skipped-existing`, `agents-md: exists`, `imported: 0` — idempotent.
Unit gate: `bun test packages/omo-native/test` → 331 pass / 0 fail in scope (1 pre-existing
environmental failure in compile-prebuilds.test.ts: requires bun ≥1.4, this machine has 1.3.14;
9 skips are bun-1.3 node:sqlite skips — both pre-existing, unrelated to this change).

## WHY IT IS ENOUGH
The real binary drove the real code path end to end (detection → plan → consent(--yes) → write →
report) on a fabricated state covering every new branch: remap, oauth skip+guidance, gateway split,
MCP local/remote translation incl. JSONC comments, skills, AGENTS.md, and idempotent re-run.
Sources were only read (fixture assertions in test/setup-import.test.ts hash-check source files).

## WHAT WAS OMITTED
Dummy credential values only — no real auth material. The interactive TTY consent path is covered
by the unit suite (tty-driver.py), not repeated here. The sandbox/ tree is scratch state kept for
inspection; it contains no secrets.

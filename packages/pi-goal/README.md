# pi-goal — Senpi Ultragoal

Persistent `/ultragoal` support for pi and Senpi. The extension keeps the Codex-compatible goal tool contract (`create_goal` / `get_goal` / `update_goal`, session-scoped goal store, token/time accounting) and drives the work with the Senpi Ultragoal workflow: durable todo decomposition, dependency-ordered execution, evidence checkpoints, and a prompt-to-artifact completion audit.

This package is a private workspace package (`@oh-my-opencode/pi-goal`) inside the oh-my-openagent monorepo. It is not published to npm. It ships in two forms:

- standalone Pi extension entry at `src/index.ts` (the `pi.extensions` manifest field), and
- bundled into the omo-senpi Pi package as `packages/omo-senpi/plugin/extensions/ultragoal.js`.

## Local development

```bash
pi -e ./src/index.ts
```

## Commands

```bash
/ultragoal <objective>
/ultragoal
/ultragoal pause
/ultragoal resume
/ultragoal clear
```

Goals are stored under Pi's active session directory, keyed by session id. If Pi is launched without a persisted session, the extension falls back to `$PI_CODING_AGENT_DIR/extensions/pi-goal/...`. That means `PI_CODING_AGENT_DIR=$HOME/.senpi/agent` keeps goal state under `~/.senpi/agent/...` even when pi is launched from a workspace such as `~/local-workspaces/senpi-mono`.

Objectives are unbounded in length after trimming; empty objectives remain invalid.

## Agent Tools

- `create_goal({ objective, token_budget? })` creates a new active goal. This follows Codex's model-facing schema.
- `update_goal({ status: "complete" | "blocked" })` only marks the current goal complete or blocked. Pause, resume, budget-limited, and clear transitions are user/system controlled.
- `get_goal({})` returns the current goal summary.

Statuses are `active`, `paused`, `blocked`, `budgetLimited`, and `complete`. When a goal reaches its token budget, the extension marks it `budgetLimited` and queues a prompt asking the agent to summarize remaining work instead of silently continuing.

## TUI Behavior

When a goal exists, pi keeps the normal footer information and renders the Ultragoal indicator on the bottom-right footer line: `Pursuing ultragoal (...)`, `Ultragoal paused (/ultragoal resume)`, `Ultragoal unmet (...)`, or `Ultragoal achieved (...)`. The older below-editor goal widget is cleared.

On session start, after `/ultragoal <objective>`, after `/ultragoal resume`, and after every agent turn that leaves the goal `active`, the extension queues the Ultragoal continuation prompt as hidden model-visible context. The objective is XML-escaped and wrapped as untrusted user data so it does not become higher-priority instructions.

## Development

```bash
bun test test
bun run typecheck
node scripts/qa/drive.mjs --self-test
node scripts/qa/drive.mjs   # live pi-harness proof (RPC mode, sandboxed)
```

See [`AGENTS.md`](./AGENTS.md) for the full package anatomy, compatibility notes, and QA rules.

## Related

- [senpi](https://github.com/code-yeongyu/senpi) — the fork/runtime these extensions are extracted from.
- [Ultraworkers Discord](https://discord.gg/PUwSMR9XNk) — community link from the senpi README.
- [Dori](https://sisyphuslabs.ai) — the product powered by senpi under the hood.

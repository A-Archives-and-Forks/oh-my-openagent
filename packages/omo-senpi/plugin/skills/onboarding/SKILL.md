---
name: onboarding
description: "Onboarding tour for first-time omo users"
---

# onboarding - the first conversation with omo

## Purpose

This skill runs the first conversation a new omo user ever has. You are the guide. Walk the user
through six lanes, in order: the feature tour, migration help, session archaeology, value mapping,
memory recording (which runs through the whole flow, not at the end), and the first-session
init-deep proposal. Three of the lanes are opt-in. When the user declines one, move on without
argument and without repeating the offer.

Detect the user's language from their first reply and respond in that language for the rest of the
conversation. The skill is written in English; your output is not. Match them exactly, including
tone.

Use Senpi-native tools only: `read`, `bash`, `edit`, `write`, the `memory` tools, and skill
invocations. Never assume a tool from another agent product exists here.

Be concrete, never generic. "omo caches your context" is a failure of this skill. "Your last week
of Claude Code sessions read 4.7M tokens from cache at a 78% hit rate; here is what that would
have cost cold" is the bar.

## 1. Feature tour

Open by introducing yourself and giving a short tour of what omo adds on top of a plain coding
agent. The catalog below is baked in at authoring time because the user's machine has no omo or
senpi source tree to explore. Present it conversationally, three to five highlights at a time, and
let the user ask for depth on any item. Do not dump the whole list as a wall of text.

The baked catalog:

- **Senpi-native skills** that ship with omo: `init-deep` (deep AGENTS.md generation for a
  project), `ultrawork` and `ulw-loop` (sustained autonomous work loops), `ulw-plan` and
  `ulw-research` (planning and research lanes), `hyperplan` (heavyweight planning), and
  `give-me-tips` (deep, verified explanations of any Tip: line the TUI shows).
- **The fallback architect**: when a top-tier model refuses, omo detects the refusal from the real
  stop metadata, routes the question through an architect consultation lane the refusal cannot
  block, and shows the user a Tip: line explaining what happened. The refused question is never
  lost.
- **Memory**: omo records durable facts about the user and their projects through dedicated memory
  tools, so later sessions start already knowing their stack, preferences, and habits.
- **Start-work continuation**: interrupted work leaves a ledger under `.omo/` so a fresh session
  can pick up exactly where the last one stopped.
- **Tips with a live source of truth**: `senpi --list-tips` prints the real tip catalog as JSON,
  and the `give-me-tips` skill explains any of them from the actual implementation code, gated by
  what this specific user can see.
- **Interactive UI primitives**: omo components can put real pickers, confirms, and inputs in
  front of the user, in the TUI and in the desktop app alike, instead of burying choices in prose.
- **Re-running this tour**: onboarding auto-starts once, ever. The user can bring it back any time
  with the `omo --onboard` flag, or shut the auto-start off with the
  `omo-senpi-onboarding-disabled` flag.
- **Session archaeology**: the bundled `coding-agent-sessions` skill can find and read local
  sessions from Co&#x64;ex, Claude Code, OpenCode, senpi, and a long tail of other agent products.
  Lane 3 of this flow uses it.
- **The init-deep advisor**: after this first session, omo watches each project for AGENTS.md
  coverage gaps and drift, and proposes an init-deep run only when the numbers justify one. On
  this first session, you carry that proposal yourself in lane 6.

While the user reacts to the tour, start lane 5: record what you learn about them through the
memory tools as you learn it.

## 2. Migration help

Ask whether the user is coming from another coding agent and would like their setup carried over.
This lane is opt-in. If they say no, skip to lane 3.

If they say yes, scrape their existing configuration from as many sources as exist on this
machine. Check at least:

- Claude Code: `~/.claude/settings.json`, project and global `CLAUDE.md` files, MCP server
  definitions in `.mcp.json` or settings.
- Co&#x64;ex: <code>~/.co&#x64;ex/config.toml</code>, any `AGENTS.md` files it manages.
- OpenCode / oh-my-openagent: `opencode.json`, its config directory, MCP definitions.
- Anything else the user names.

Read what you find, then present one concrete migration plan: which settings map to `omo.json`,
which MCP servers move to `.mcp.json`, which `CLAUDE.md` content becomes `AGENTS.md` content, and
which personal facts belong in memory instead of files. Show the plan and WAIT for the user to
accept it. Apply nothing before they say yes. If they accept part of it, apply that part only.
Record their agent-product history and migration choices through the memory tools.

## 3. Session archaeology

Ask the user, in your own voice and their language, a question that means: "may I look through
your previous coding-agent sessions?" Phrase it naturally; do not read that sentence out like a
script. This lane is opt-in. If they say no, skip to lane 4 and base it on nothing.

If they say yes, drive the `coding-agent-sessions` skill: read its SKILL.md and follow it. Use the
bundled finder to list sessions across every platform present on the machine, then go deep on the
interesting ones. Mine for:

- how they actually work: hands-on-the-wheel back-and-forth versus long one-shot delegations,
- what frustrates them: repeated corrections, abandoned sessions, prompts that read as annoyed, in
  any language,
- how much they run in parallel, and how long their longest sessions run,
- which repos, stacks, and models dominate their history.

Weave in migration suggestions where the history invites them, lightly. When a pattern you find
maps to an omo feature from the tour, say so with the evidence: "you corrected the agent about
your test runner in nine sessions; memory ends that" lands, a generic pitch does not. Record every
durable finding about the user through the memory tools as you go.

## 4. Value mapping + savings

From the session data gathered in lane 3, give the user quantified estimates of what omo's caching
would have been worth on their real workload. Compute, do not guess:

- their cache hit rate: cache-read tokens over cache-read plus fresh input tokens, from the
  per-message `usage` records (`input`, `output`, `cacheRead`, `cacheWrite`) in their session
  files,
- attribute each message's usage to the model active at that point in the session, meaning the
  most recent `model_change` event before it in file order,
- their actual spend versus what the same traffic would have cost with every cached read billed at
  the full input rate, using per-model prices; models without a known price contribute tokens to
  the totals but are left out of the cost figures,
- sum everything exactly and round only the final numbers you present.

Label the result as an estimate and give exactly one line of methodology, in this shape: "Estimate
from your local session logs: per-message usage attributed to the active model, cache reads priced
at cache-read rate versus full input rate, summed across sessions, rounded at the end." One line,
then the numbers, then stop. No hedging beyond the word estimate.

If the user skipped lane 3, skip this lane too; there is no data to map.

## 5. Memory recording

This lane has no fixed position: it runs through the entire flow. Whenever any lane teaches you
something durable about the user, write it through the `memory` tools at that moment, not in a
batch at the end. Worth recording:

- their language and communication style,
- which agent products they came from and what they kept from them,
- their stacks, main repos, and working patterns from lane 3,
- their stated preferences and every accept or decline decision from this conversation.

Record facts, not narration. "Prefers Korean, migrated from Claude Code, works one repo at a time
in long sessions" is a memory. "The user went through onboarding today" is not.

## 6. First-session init-deep proposal

On the true first session the advisor component stays quiet, so this proposal is yours to carry.
Before saying anything about it, run the same eligibility gate the advisor uses, in this order:

1. The current directory must be inside a git repository. Check with
   `git rev-parse --show-toplevel`. Not a repo: ineligible.
2. There must be candidate directories worth documenting: directories within depth 3 of the repo
   root (excluding `node_modules`, `.git`, `dist`, `build`, `vendor`, `.next`, `__pycache__`,
   `.venv`, `target`, `coverage`, `third_party`) holding at least 8 source files or at least 500
   lines of source directly in them. Zero candidates: ineligible, regardless of anything else.
3. Compute coverage: a candidate counts as covered when it or an ancestor up to the repo root has
   an `AGENTS.md`. The missing ratio is uncovered candidates over all candidates. Below 0.50:
   ineligible. A new project with candidates and no `AGENTS.md` anywhere is missing ratio 1.0 and
   eligible.

If any gate fails, skip this lane SILENTLY. Do not mention AGENTS.md, do not explain why you are
not proposing, do not hint that a check ran. Close the conversation warmly instead.

If all gates pass, ask in the user's language: "want me to set up AGENTS.md for this project?"
This is opt-in. On yes, read the `init-deep` skill at its SKILL.md path and follow it. On no,
record the decline through the memory tools and finish the conversation gracefully: a short
send-off in their language, an invitation to come back with `omo --onboard`, and nothing more.

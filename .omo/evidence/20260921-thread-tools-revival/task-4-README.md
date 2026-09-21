# Task 4: thread docs, package AGENTS.md, change record

## WHAT WAS TESTED

Four greps from the task's VERIFY block, run before (RED) and after (GREEN) the edits, from the
worktree root. Transcript: `task-4.log` beside this file.

1. `grep -n "No assembled" packages/omo-senpi/src/components/thread/AGENTS.md`
2. `grep -nE "unassembled|not yet in the live component" packages/omo-senpi/AGENTS.md`
3. `grep -c "thread_rename\|thread_set_model\|thread_set_reasoning" packages/omo-senpi/src/components/thread/AGENTS.md`
4. `grep -n thread_set_reasoning packages/omo-senpi/changes.md`

Plus an `rg` audit for em/en dashes in the thread AGENTS.md and the new changes.md entry, and
`git status --short` to confirm only in-scope files changed by this task.

## WHAT WAS OBSERVED

RED: grep 1 hit line 5 ("No assembled `thread_*` tool handler exists yet"); grep 2 hit lines 14
and 49 ("unassembled", "not yet in the live component registration list"); grep 3 printed 0;
grep 4 printed nothing (exit 1).

GREEN: grep 1 and grep 2 printed nothing (exit 1); grep 3 printed 3 (exit 0); grep 4 printed
line 970 of changes.md (exit 0). The dash audit found none in either file. `git status` showed the
three doc files modified; `live-surface.ts` and `live-surface.test.ts` also show modified, from a
sibling node, untouched here.

## WHY IT IS ENOUGH

The task is prose brought to the state of the committed code. The greps pin the exact stale
sentences that had to go and the exact new names that had to appear. Content accuracy was
checked by reading the source of truth before writing: `errors.ts` (30 codes, four not in the
old list: `host_unavailable`, `model_not_found`, `model_ambiguous`, `thinking_level_unsupported`),
`contracts.ts` (params and result shapes for the three new tools), `tools.ts` (the `"self"` rule,
per-call `sessionManager.getSessionId()`, fuzzy exclusion of the caller, the `host_unavailable`
mapping), `component.ts` (unconditional registration), `live-surface.ts` (eleven host methods),
and `component-list.ts` (thread right after task). No machine-consumed value changed, so no test
was added or modified.

## WHAT WAS OMITTED

No typecheck or test run: only markdown changed. The task brief said 29 error codes; `errors.ts`
has 30, and the docs follow the file. The top-level AGENTS.md component count went from "Twenty"
to "Twenty-one" to include `thread`; that line still omits `model-profile` and `bundled-skills`,
which `component-list.ts` registers but which predate this task and were left alone. The dated
`## YYYY-MM-DD — title` heading form in changes.md uses an em dash; the new entry uses the file's
undated `## title` form instead.

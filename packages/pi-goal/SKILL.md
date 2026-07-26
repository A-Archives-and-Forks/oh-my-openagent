---
name: ultragoal
description: Persistent Senpi Ultragoal workflow. Use when the user explicitly asks to set, continue, audit, pause, resume, complete, or inspect a long-running goal.
source: Adapted from Gajae-Code Ultragoal at b0fd6a7ee771d22918d0429e319bbe26e4e247fa.
---

# Senpi Ultragoal

Use goal tools only when the user explicitly wants persistent goal tracking or when an active goal already exists.

## Tools

Create a goal:

```ts
create_goal({
	objective: "Ship the pi-goal extension",
	token_budget: 50000,
});
```

Inspect a goal:

```ts
get_goal({});
```

Update a goal:

```ts
update_goal({
	status: "complete",
});
```

`update_goal` only accepts `complete`. User-facing `/ultragoal` commands control pause, resume, budget-limited, and clear transitions.

For objectives with three or more distinct steps, initialize a `todo` list that maps every explicit requirement to a concrete task. Execute tasks in dependency order, delegate independent work through `task` agents when useful, and checkpoint each success, failure, blocker, and verification result immediately. The prompt-to-artifact completion audit below remains the final gate.

## Completion Rule

Before marking a goal complete, audit the actual current state:

1. Restate the goal as concrete deliverables.
2. Map every explicit requirement to real evidence.
3. Inspect files, command output, test results, or repository state for each item.
4. Treat uncertainty as incomplete.
5. Call `update_goal({ status: "complete" })` only when no required work remains.

Use budget-limited status when the reason to stop is budget exhaustion rather than completion.

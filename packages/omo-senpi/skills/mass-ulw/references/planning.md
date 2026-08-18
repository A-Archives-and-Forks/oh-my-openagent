---
name: mass-ulw
description: Mandatory planning reference for the mass-ulw skill - read in full BEFORE defining any graph. Covers decomposition doctrine, category routing, concurrency and write-scope rules, the node prompt contract, the verification wave, and the failure playbook.
metadata:
  short-description: How to plan a dag - decomposition, categories, node prompts, verification
---

# mass-ulw planning reference

Read this file IN FULL before you define any graph. A graph defined without it is unplanned work: real runs without this doctrine collapse to three `deep` nodes with no verification. Every section below exists because its absence was observed failing.

## Decomposition doctrine

**TOPOLOGY LOCK first.** Before writing any node, enumerate the 1-6 top-level components that can each succeed or fail independently. Every node you define traces to exactly one component. Do not collapse a multi-component request into one blob node because it "looks small" - and do not invent components the request does not have.

**Wave sizing.** Target 5-8 nodes per parallel wave; fewer than 3 means under-splitting. Split along the axis that makes pieces independent:

- **By component** - each independently-shippable part is its own lane.
- **By file domain** - when one component spans disjoint file sets, one node per set.
- **By phase** - collect lanes (investigate, in parallel) -> verify lanes (falsify the collections) -> synthesize (turn verified facts into the deliverable).

**Default shape is fan-out, then fan-in.** N parallel lanes with no dependencies, then one synthesis node that depends on all of them. A 2-node graph with no dependency between the nodes is not a dag - use plain parallel `task` spawns instead. Reach for `dag` when ordering itself is the point.

**Split implementation from its test? No.** One node owns one deliverable end to end: the change AND its proof. A node that only writes code and a node that only tests it serialize on the same files and double the coordination cost.

## Category routing

`category` routes the node to a model and a worker profile. Choose the CHEAPEST category that can do the node well. `deep` is not the default - it is the escalation.

| Category | Route a node here when |
| --- | --- |
| `quick` | Mechanical, single-file, or pattern-following work. THE DEFAULT for every splittable piece. |
| `unspecified-low` | Small miscellaneous work that does not fit a specialty. |
| `unspecified-high` | Standard multi-file feature or fix. |
| `visual-engineering` | Frontend, UI, styling, animation. |
| `writing` | Docs, prose, technical writing. |
| `git` | Git operations only. |
| `deep` | Hairy debugging or cross-module reasoning that simpler categories already failed or would fail on. |
| `ultrabrain` | At most ONE node per graph - the single genuinely hard reasoning problem everything else depends on. |

A graph whose every node is `deep` is a routing failure: it pays the most expensive worker for mechanical lanes and starves the one lane that needed the horsepower.

## Concurrency and write-scope rules

- `dependsOn` is ORDERING ONLY - no upstream output is substituted into a downstream prompt. Every prompt stands alone (see the node prompt contract).
- **Disjoint write scopes or serialize.** No two nodes that can run in parallel may edit the same file. If two lanes must touch the same files, chain them with `dependsOn` or merge them into one node. Declare each node's read/write scope inside its prompt.
- **Never add a dependency to pass data.** If node B needs a fact node A produces, that is a real dependency - but if B only needs a fact YOU already know, paste the fact into B's prompt and leave the edge out.
- **Dependency matrix self-check before `start`:** every `dependsOn` id exists in the graph; no cycles; no node depends on something it does not actually consume; every wave has at least one runnable node.

## Node prompt contract

A node prompt is the ONLY thing the worker sees. It has no conversation history, no access to your reasoning, and no way to ask you questions. Write every prompt so a competent stranger executes it exactly. Every node prompt carries, in this order:

1. **TASK** - one imperative sentence naming the deliverable.
2. **DELIVERABLE** - the concrete artifact returned: files changed, the exact report shape, the evidence produced.
3. **SCOPE** - what the node may read and what it may write, with exact paths. Name what is OUT of scope when a neighboring node owns it.
4. **VERIFY** - the check the node runs on its own work before reporting: the literal command and its expected result.
5. **STOP WHEN** - the single observable condition that ends the node's run.

Rules that make node prompts obeyed:

- **Self-contained, always.** Paste exact paths, facts, and constraints INTO the prompt. "As discussed above" and "the issue mentioned earlier" are dangling references - the node sees neither.
- **Minimum sufficient context.** Every pasted fact must change what the node does. Context the node cannot act on steals attention from the instructions it must follow.
- **Binary observables.** PASS/FAIL must be decidable from the prompt alone: "exit code 0 and `dist/index.js` exists", never "check it works" or "make sure it's fine".
- **Positive framing.** Tell the node what to do, not what to avoid. Negative instructions compete with the worker's priors and lose; reserve NEVER/ONLY for true invariants (do not commit, do not edit outside scope).
- **Emphasis lives in the words.** UPPERCASE, **bold**, and strong declarative verbs for load-bearing rules. No emojis, no banner dividers, no decoration - the worker reads decorated sections as flavor and skips them.
- **One role per node.** A node that investigates does not also fix; a node that writes does not also review its own work. Role-stacked prompts produce workers that grade their own homework.

## Verification wave

**Every graph that changes code ends with at least one verification node** depending on ALL producer nodes. Real runs without one ship unverified work: the synthesis node's own claim is not evidence.

- The verification node runs the REAL check - the test command, the build, the endpoint call - and reports the captured output, not a summary of confidence.
- Its prompt names the exact invocation and the binary observable that decides PASS vs FAIL.
- **Node outputs are claims until verified.** A downstream node that builds on an upstream result re-checks the specific facts it depends on (the file exists, the test passes, the symbol is exported) before trusting them.

## Failure playbook

- **A failed node blocks only its dependents.** Read the node's error first; the fix is usually a NARROWER respawn, not a rerun of the graph.
- **Respawn small.** Re-`start` with the same `key` and definition reuses finished nodes' outputs - completed work is never redone. Change only what the failure taught you; never re-issue a changed definition under an old key to sneak past a conflict.
- **Cancel is for abandoning the goal**, not for impatience. A running node is alive; elapsed time alone never justifies cancelling. When you do cancel, pass a reason so the run record says why.

# Task 2 — thread_rename / thread_set_model / thread_set_reasoning: contracts, error codes, discovery metadata

Test-first addition of the three session-control thread tools' TypeBox contracts, the three
new taxonomy codes, and their tool-search metadata. All work confined to the write scope;
no git state was touched.

## WHAT WAS TESTED

**contracts.test.ts (written RED first):**
- `threadToolParamSchemas` exposes exactly nine keys, ending `thread_rename`, `thread_set_model`, `thread_set_reasoning` (verb-token uniqueness re-checked).
- `parseThreadParams` acceptance: `{thread, name}` for rename; `{thread, model}` and `{thread, model, provider}` for set_model; `{thread, level:"high"}` and `{thread, level:"low", scope:"turn"}` for set_reasoning.
- `parseThreadParams` returns `invalid_arguments` as DATA (never a throw) for: missing `name`, missing `model`, level `"ultra"`, scope `"forever"`.
- The `level` field is exactly the seven wire literals `off/minimal/low/medium/high/xhigh/max`.
- The taxonomy is the 27 legacy codes plus `model_not_found`, `model_ambiguous`, `thinking_level_unsupported`, with no duplicates.
- Wording lint (R3): no negated-use phrase in any description across all nine schemas; every valid sample round-trips unchanged.

**discovery.test.ts (written RED first):**
- `THREAD_TOOL_SEARCH_METADATA` has 9 entries with unique names.
- Labels pinned literally and verb-led: `Rename session`, `Switch session model`, `Set session reasoning level` (plus the six existing).
- No `searchKeywords` string repeats across the family; 4–6 keywords per entry; no indexed field contains a negated-use word; every entry has `exposure: "search"` and `allowLazyActivation: true`.
- Nine intent phrases each rank their intended tool first through the REAL compiled `ToolSearchService` BM25 engine; bare-name registration still leaves `thread_send` unranked; the `task` competitor still wins "spawn a background worker task" (routing clauses do not cannibalize).

## WHAT WAS OBSERVED

- **BASELINE** (unchanged code): 18 pass / 0 fail, exit 0.
- **RED** (new tests against unchanged implementation): 31 tests, 16 fail / 15 pass, exit 1. Every failure is a new or intentionally-updated assertion (nine-key list, valid-sample record, the eleven per-tool param tests, 30-code taxonomy list, nine-entry metadata, literal labels, nine-phrase ranking). No import/parse errors, no sibling interference.
- **GREEN**: `bun test packages/omo-senpi/src/components/thread/contracts.test.ts packages/omo-senpi/src/components/thread/discovery.test.ts` → 31 pass / 0 fail, exit 0.
- **Count check**: `THREAD_ERROR_CODES.length` prints **30**, not the brief's predicted 29. The brief described the baseline as 26 codes; the worktree's actual baseline is 27 (the baseline taxonomy test passes an exact 27-entry `toEqual` list, which mechanically pins the count; the brief's own "lines 5-31" reference spans 27 code lines). 27 + 3 appended = 30. Appended tail verified mechanically: `["internal_error","model_not_found","model_ambiguous","thinking_level_unsupported"]`, length=30, unique=30. Forcing 29 would require deleting a legacy code or omitting a required one — both contradict the DELIVERABLE — so the off-by-one is recorded as the brief's baseline arithmetic error, not a worktree defect.
- **Typecheck**: `./node_modules/.bin/tsgo --noEmit -p packages/omo-senpi/tsconfig.json` → exit 0.

## WHY IT IS ENOUGH

- The schemas, input types, result-union members, taxonomy codes, and metadata entries are all exercised through their real consumers: `parseThreadParams` (the validation seam the future tool handlers will call), the compiled `ToolSearchService` BM25 engine (not a mock), and the package-wide typecheck.
- RED→GREEN ordering proves the tests detect the feature's absence (16 targeted failures on unchanged code) and pass only once the implementation lands.
- The ranking assertions prove the fifteen new keyword strings neither cannibalize the six existing intent queries nor lose the `task` competitor query — the actual risk the metadata rules exist to prevent.

## WHAT WAS OMITTED

- No tool handler, live-surface, component, or compose wiring for the three tools — owned by sibling nodes (out of this task's write scope).
- `AGENTS.md` still documents "six tools" and the 26-code taxonomy list — file is outside this task's write scope; doc sweep belongs to the revival's integrator.
- No length-boundary tests for `name` (1/200) or `model` (1) — the deliverable's required assertions cover presence/absence semantics; the length constraints are declared in the schemas and enforced by the same TypeBox check.
- The 29 print target was not met (30 observed); see WHAT WAS OBSERVED for the baseline-arithmetic reason.

# Task 1 — Remove the shared-host registration gate from the thread component

## WHAT WAS TESTED

- `packages/omo-senpi/src/extension/thread-policy.test.ts` rewritten as a 9-row `test.each` matrix (policy true/false/undefined x env "0"/"1"/undefined). Every row drives the full `composeOmoSenpiExtension([createThreadComponent({ stateDirectory })])` pipeline against a `FakeExtensionAPI` and asserts exactly six tool names in order — `thread_create`, `thread_list`, `thread_read`, `thread_send`, `thread_interrupt`, `thread_handoff` — each with `exposure` `"search"` and `allowLazyActivation` true. The `OMO_ENABLE_SHARED_HOST` save/restore and the `mkdtemp` stateDirectory are retained.
- `packages/omo-senpi/src/components/thread/component.test.ts`: the former "does not register tools when shared host is disabled" case rewritten as "registers the family regardless of the context flag" asserting the same six names, and the `sharedHostEnabled` parameter removed from the `context()` fixture.

## WHAT WAS OBSERVED

- RED (production untouched): the six policy-false/undefined rows each failed with `expect(received).toEqual(expected)` — expected the six-name array, received `[]` ("Expected - 8 / Received + 1", `+ []`). The three policy-true rows passed, isolating the gate as the sole production cause. All three component.test.ts cases failed with 0 tools because the rewritten fixture no longer supplies the flag. `RED_EXIT=1`.
- GREEN (gate line deleted from `component.ts`, `sharedHostEnabled: pi.sharedHostEnabled === true` deleted from `compose.ts`, both `sharedHostEnabled` fields deleted from `types.ts`): 12 pass, 0 fail, `GREEN_EXIT=0`.
- FINAL: the policy column was demoted to documentation — the field no longer exists on `SenpiExtensionAPI`, so the RED-era `Object.assign` that set it was removed from `thread-policy.test.ts` (required for the grep-clean end state). Re-run: 12 pass, `FINAL_TEST_EXIT=0`. `grep -rn sharedHostEnabled packages/omo-senpi/src` printed nothing (`GREP_EXIT=1`). `./node_modules/.bin/tsgo --noEmit -p packages/omo-senpi/tsconfig.json` exited 0.

## WHY IT IS ENOUGH

- The RED run failed on precisely the rows whose policy made `ctx.sharedHostEnabled` non-true and on nothing else in the policy file, proving the gate was the only thing standing between the old and new behavior.
- The GREEN and FINAL runs exercise the real compose -> component -> `registerThreadTools` path (not just the isolated component): all nine (policy, env) combinations register the identical six tools with the mandated exposure and lazy-activation flags, and the component registers the family with a context that carries no flag at all.
- The empty grep proves the token is gone from the entire package source — no producer, no consumer, no dead declaration — and the clean typecheck proves the deletion broke no other file in the package.

## WHAT WAS OMITTED

- No edits to `contracts.ts`, `errors.ts`, `metadata.ts`, `tools.ts`, `live-surface.ts` (sibling-owned, out of write scope).
- The pre-existing test "registers all six tools when shared host is enabled" in `component.test.ts` was left untouched (deleting tests is forbidden); its name now refers to a concept no longer encoded in production.
- The "regardless of the context flag" case supplies a test host; it does not exercise the live-surface fallback taken when no host is injected.
- No git add/commit/stash/checkout/reset — a later node commits.

# Task 7 evidence: prompt_submitted pipeline

## Scope

Implemented:

- `packages/omo-senpi/src/components/telemetry/omo-native-prompt.ts`
- `packages/omo-senpi/src/components/telemetry/omo-native-prompt.test.ts`

The input handler snapshots arming state and classifies the raw input before returning control to later input handlers. Pending state contains only classification, source, streaming behavior, buckets, and a hashed session id. It never stores prompt text and never calls an arming-ledger mutator.

## RED

Command:

```sh
bun test packages/omo-senpi/src/components/telemetry/omo-native-prompt.test.ts
```

Output before implementation:

```text
bun test v1.4.0-canary.1 (b58cd4685)

packages/omo-senpi/src/components/telemetry/omo-native-prompt.test.ts:

# Unhandled error between tests
-------------------------------
error: Cannot find module './omo-native-prompt' from '/Volumes/mengmotaStorage/local-workspaces/omo-wt/feat/omo-native-telemetry/packages/omo-senpi/src/components/telemetry/omo-native-prompt.test.ts'
-------------------------------


 0 pass
 1 fail
 1 error
Ran 1 test across 1 file. [135.00ms]
```

## GREEN

Focused command:

```sh
bun test packages/omo-senpi/src/components/telemetry/omo-native-prompt.test.ts
```

Output:

```text
bun test v1.4.0-canary.1 (b58cd4685)

packages/omo-senpi/src/components/telemetry/omo-native-prompt.test.ts:
(pass) OmO Native prompt telemetry > #given canonical ultrawork prompts #when dispositions arrive #then pre-mutation classifications and buckets are emitted
(pass) OmO Native prompt telemetry > #given suppression and source cases #when submitted #then skill names do not match and extension prompts stay non-real
(pass) OmO Native prompt telemetry > #given queued steering and duplicate dispositions #when handled #then queue semantics emit exactly once
(pass) OmO Native prompt telemetry > #given telemetry snapshots before the mutating handler #when arming changes before disposition #then first arm is preserved
(pass) OmO Native prompt telemetry > #given every disposition and prompt size boundary #when emitted #then queue, length, and ordinal buckets are stable per session
(pass) OmO Native prompt telemetry > #given pending input at shutdown #when shutdown flushes then a late disposition arrives #then one other-mode event remains
(pass) OmO Native prompt telemetry > #given malformed and adversarial inputs #when dispatched #then valid text emits without retaining text and missing ids are ignored

 7 pass
 0 fail
 22 expect() calls
Ran 7 tests across 1 file. [1388.00ms]
```

The test count delta is explicit: the focused file went from no loadable implementation and 0 passing tests to 7 passing tests. The full telemetry directory contains 55 passing tests, of which 7 are task 7 tests and 48 are other telemetry tests.

Required suite:

```sh
bun test packages/omo-senpi/src/components/telemetry
```

Result:

```text
55 pass
0 fail
171 expect() calls
Ran 55 tests across 8 files. [1023.00ms]
```

Typecheck:

```sh
bun run --cwd packages/omo-senpi typecheck
```

Result:

```text
$ tsgo --noEmit -p tsconfig.json
```

Source checks:

```sh
wc -l packages/omo-senpi/src/components/telemetry/omo-native-prompt.ts
# 193 packages/omo-senpi/src/components/telemetry/omo-native-prompt.ts

git diff --check -- packages/omo-senpi/src/components/telemetry/omo-native-prompt.ts packages/omo-senpi/src/components/telemetry/omo-native-prompt.test.ts
# no output
```

## Manual QA payload table

Literal command:

```sh
cd /Volumes/mengmotaStorage/local-workspaces/omo-wt/feat/omo-native-telemetry && bun /tmp/omo-native-prompt-qa.ts
```

The throwaway script registered `createOmoNativePromptComponent` before `createUltraworkComponent`, dispatched six canonical prompts through `FakeExtensionAPI`, and used `createEventTelemetryClient` with a recording transport.

Real stdout:

```text
┌───┬───────┬─────────────┬───────────┬───────────┬─────────────┬───────────┬────────────────────┬───────────┬─────────┬────────┐
│   │ input │ source      │ queue     │ variant   │ occurrences │ effective │ stage              │ real      │ ordinal │ length │
├───┼───────┼─────────────┼───────────┼───────────┼─────────────┼───────────┼────────────────────┼───────────┼─────────┼────────┤
│ 0 │ p1    │ interactive │ immediate │ none      │ 1           │ false     │ none               │ undefined │ 1       │ lt_100 │
│ 1 │ p2    │ interactive │ immediate │ ulw       │ 3_5         │ true      │ first_arm          │ undefined │ 2_3     │ lt_100 │
│ 2 │ p3    │ interactive │ steer     │ ulw       │ 1           │ true      │ remention          │ undefined │ 2_3     │ lt_100 │
│ 3 │ p4    │ interactive │ immediate │ ultrawork │ 1           │ true      │ post_compact_rearm │ undefined │ 4_10    │ lt_100 │
│ 4 │ p5    │ interactive │ other     │ none      │ 1           │ false     │ none               │ undefined │ 4_10    │ lt_100 │
│ 5 │ p6    │ extension   │ other     │ ulw       │ 1           │ false     │ none               │ undefined │ 4_10    │ lt_100 │
└───┴───────┴─────────────┴───────────┴───────────┴─────────────┴───────────┴────────────────────┴───────────┴─────────┴────────┘
```

### Cross-wave contract defect found by real transport QA

The task 7 handler supplies `is_real_user_prompt` and its unit test pins the call-site property key set byte-for-byte to `OMO_NATIVE_PROPERTY_ALLOWLISTS.prompt_submitted`. The committed telemetry-core wrapper then drops that property before transport because `packages/telemetry-core/src/events.ts` rejects every client-authored key matching `/_prompt$/`. The product allowlist simultaneously requires `is_real_user_prompt`, so the two committed Wave 1 contracts conflict. This is why the real transport table reports `real` as `undefined` for every row.

Fixing the wrapper is outside task 7's explicit write scope. No out-of-scope file was changed. Until telemetry-core permits this specific allowlisted boolean, end-to-end payload-key equality is not green even though this module's emitted property set is exact.

## Adversarial results

| Case | Result |
| --- | --- |
| empty text | Classified and emitted without throw; length bucket `lt_100`; no text retained |
| 100KB text | Classified and emitted without throw; length bucket `gte_2000`; no exact length or text retained |
| regex-special characters | Classified as no keyword without regex failure |
| Unicode plus `ulw` | Unicode preserved only for classification scope; keyword detected; no text retained |
| missing inputId | Input ignored without throw |
| unknown disposition inputId | Ignored without throw |
| double disposition | Exactly one event emitted |
| ordinals in two sessions | Each session starts at ordinal bucket `1` |
| shutdown without disposition | Emitted once with `queue_mode: "other"` and `is_turn_start: false` |
| disposition after shutdown flush | Ignored; no duplicate event |
| handler-order simulation | Snapshot captured first-arm, ledger mutated afterward, emitted stage remained `first_arm` |
| extension source | Call-site payload has `is_real_user_prompt: false`, stage `none`, suppression `extension_source` |
| payload privacy | Call-site key set exactly equals prompt allowlist; no `text` property; implementation stores only derived fields |

## Cleanup receipt

```text
removed /tmp/omo-native-prompt-qa.ts
removed /tmp/task-7-red.txt
removed /tmp/task-7-green-suite.txt
removed /tmp/task-7-typecheck.txt
removed /tmp/task-7-qa-output.txt
```

# QA evidence — native-edition nudge (#8619)

Change: a new `native-edition-nudge` hook in `packages/omo-opencode/src/hooks/`, registered in the
event-hook dispatcher, the hook-name schema, and the session-hook composer.

## WHAT WAS TESTED

1. **The decision core, every suppression condition beside a control** — `bun test packages/omo-opencode/src/hooks/native-edition-nudge`.
   Each of the 11 suppression conditions is asserted twice: once with the condition set (must stay
   silent) and once with only that condition cleared (must show). A blanket refusal would pass the
   first half of every pair and fail the second.
2. **That the suppression assertions can actually fail** — the child-session guard was deleted from
   the production source and the suite re-run.
3. **The throttle across real processes, against a real state file on disk** — `real-fs-drive.ts`,
   committed beside this file and re-runnable with `bun .omo/evidence/20260922-native-nudge/real-fs-drive.ts`.
4. **Registration position on the wire** — the dispatcher, schema and composer entries.
5. **SSE plumbing behind the `event` hook** — `.agents/skills/opencode-qa/scripts/sse-hook-probe.sh`.

## WHAT WAS OBSERVED

**1. Unit suite:** `48 pass, 0 fail` across `decide.test.ts`, `state.test.ts`, `hook.test.ts`.
Artifact: `GREEN-suppression-matrix.txt`.

**2. Mutation proof:** removing `if (input.childSession) return deny("child-session")` produced
`25 pass, 1 fail`, and the single failure was exactly
`#given the session is a child session #when decided #then it stays silent`. Reverting restored
`26 pass, 0 fail`. Artifact: `MUTATION-child-session-guard-removed.txt`.

**3. Real-filesystem throttle lifecycle** — a real state directory, no fakes:

| step | expectation | observed |
| --- | --- | --- |
| session 1, eligible | toast, state written | 1 toast; `autoShows: 1`, `nextEligibleAt` = +3 days |
| session 2, same process | silent | still 1 toast |
| session 3, NEW process, same day | silent, throttled by the file | still 1 toast |
| session 4, NEW process, +4 days | toast, window widened | 2 toasts; `autoShows: 2`, `nextEligibleAt` = +7 days |
| session 5, native edition installed | silent | still 2 toasts |

Step 3 is the one that matters: a fresh process re-read the on-disk `nextEligibleAt` and stayed
silent, which is what separates a throttle from a per-process latch. Step 4 confirms the widening
3d → 7d interval rather than a fixed one.

The text a user actually sees:

```
Try OmO Native: no host app needed
Same agent, one binary, nothing else to keep updated.
Install: bun add -g omo-ai@beta
```

**4. Registration** (artifact: `GREEN-registration.txt`):

```
event-hook-dispatcher.ts:41  runEventHookSafely("legacyPluginToast", ...)
event-hook-dispatcher.ts:42  runEventHookSafely("nativeEditionNudge", ...)
config/schema/hooks.ts:61    "native-edition-nudge",
create-session-hooks.ts:234  isHookEnabled("native-edition-nudge")
```

Line 42 follows line 41, so a legacy-plugin migration toast still wins the first session. The schema
entry is what makes `disabled_hooks: ["native-edition-nudge"]` work.

**5. SSE:** `PASS: SSE /event opened and delivered server.connected`, run against an isolated
spawned server. The real `~/.local/share/opencode/opencode.db` was not touched — the bundled script
sandboxes `XDG_*` itself.

`bunx tsgo --noEmit` over `packages/omo-opencode` exits 0.

## WHY IT IS ENOUGH — AND WHERE IT IS NOT

Enough for the logic: the feature's only real failure mode is firing at the wrong moment, and every
condition that must suppress it is pinned beside a control that proves the assertion can fail. The
cross-process throttle is proven against a real file rather than a mock, which is the part unit
doubles cannot establish.

**Live event capture — what is and is not proven.**

`live-session-created.sh` boots an isolated opencode server, creates a real session over
`POST /session`, and reads the SSE stream. Run 1 (`GREEN-live-session-created.txt`) proves the claim
that matters: **a real opencode process emits `session.created` when a session is created**, for
session `ses_f380eba8…`. That line came from an unanchored grep and is genuine.

The same run also printed a top-level/parentID PASS that was **vacuous** and is not evidence: it
consumed an anchored grep (`{"type":"session.created"`) that assumes `type` is the first JSON key,
while the real frame puts `type` last, so it matched nothing and the branch could not fail. The
artifact states this inline rather than letting the green line stand. The grep is fixed in the
script, and `GREEN-assertions-can-fail.txt` drives the corrected logic against three synthetic
frames — type-last without `parentID`, type-last with `parentID`, and no event at all — showing all
three branches reachable, so the assertion can now fail.

**The live run now reaches the corrected assertions end to end.** On an uncontended box
(load 15.24, 0 vitest, 1021 MB free) the capture booted an isolated server, created session
`ses_f37f57bbfffeVOawJuxnl5Rn1S` over `POST /session`, and captured the 501-byte frame:

```
data: {"id":"evt_0c80a8441001nHsYuYvRdGFGD7","type":"session.created","properties":{"sessionID":"ses_f37f…
```

Both assertions pass on their corrected form — the event was emitted, and the frame is top-level with
no `parentID`, which is the condition the hook requires to fire. The frame also settles the earlier
defect concretely: `"type"` is the **second** key, after `"id"`, so the anchored grep could never have
matched. Teardown verified in the capturing step: 0 opencode processes, 0 sandboxes.

**The command wiring is now driven, not assumed** (`features/native-edition-nudge/register.test.ts`).
`registerNativeEditionNudgeTui` is invoked with a recording fake API, and the test asserts what a
user actually reaches: exactly one command is registered, its slash name is `native`, selecting it
opens a dialog offering all four actions, and choosing one applies the action, clears the dialog and
emits exactly one toast. The install path is asserted to write **nothing**, which is what stops a
failed install from silencing the nudge permanently.

**What that does and does not claim.** It proves the descriptor and the select path are correct. It
does **not** prove OpenCode renders the dialog — `registerNativeEditionNudgeTui` contains no
rendering logic of its own; it hands a descriptor to `api.command.register` and calls OpenCode's own
`DialogSelect`. A TUI frame capture would be asserting OpenCode's contract, not this module's, and
the `opencode-qa` skill explicitly rules that surface out: "Asserting on conversation OUTPUT by
scraping the frame is FRAGILE and not recommended … tmux for smoke, server/SSE or /tui/* control for
assertions." The two sanctioned surfaces are both covered here — the event on the wire for the toast
path, a driven unit for the command path.

**Remaining risk, stated rather than hidden:** if OpenCode changes the shape it expects from
`command.register` or `DialogSelect`, these tests keep passing while the real palette breaks. That is
a contract-drift risk shared by every plugin command in this package, not specific to this one.

## WHAT WAS OMITTED

No secrets, tokens, auth headers or environment dumps are recorded here. The temp state directory
is referred to by basename only; the drive script removes it on exit and the final line of its
output shows the state file absent afterwards.

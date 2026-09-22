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

**Not yet sufficient for merge.** Two gaps remain, and I am not claiming them:

- **No live TUI capture.** The SSE probe proves the plumbing that carries `session.created`; it does
  not show this hook's toast rendering inside a running OpenCode TUI. That needs an
  `--attach` run against a live server with a real session creation, per the `opencode-qa` skill's
  Case B.
- **No TUI command or dialog yet.** Issue #8619 also asks for a command-palette entry opening an
  install / guide / later / never dialog. Only the toast half is implemented.

This PR should not merge until both are done.

## WHAT WAS OMITTED

No secrets, tokens, auth headers or environment dumps are recorded here. The temp state directory
is referred to by basename only; the drive script removes it on exit and the final line of its
output shows the state file absent afterwards.

# Task 3c - make a created thread addressable and keep it alive

## WHAT WAS TESTED
`live-surface.ts` `openSession`, through three new cases in `live-surface.test.ts` plus the live `session-control-qa.mjs` scenario on a real multi-session host.

## WHAT WAS OBSERVED
Two pre-existing defects, both proven live before the fix (see task-3c.log):
1. `open_session` answers with the ROUTING id and a state carrying neither the durable id nor a name, while the address book keys every entry by the DURABLE id - so `thread_create` returned an id that resolved to `not_found` on the next call, and its documented `name` parameter was silently dropped.
2. `open_session.retain_on_disconnect` defaults to false. This client is one-shot, so the opening connection drops immediately and the host moved the new session to `closing`; every later call answered `session_closing`.
After the fix: `22 pass / 0 fail` in the file, `199 pass / 0 fail` across the thread suite, tsgo exit 0, and the live scenario `failures=0 skipped=0` with CLEANUP OK.

## WHY IT IS ENOUGH
The unit cases pin the wire contract (frame order, the retain flag, the merged durable id and name); the live scenario proves the same path against the engine this repo pins, where the defects were originally observed. Without both fixes `thread_create` cannot produce a usable thread at all.

## WHAT WAS OMITTED
No engine change - the engine already offered `retain_on_disconnect`; omo was simply not asking for it. `forkFrom` is still passed through to a wire that has no such field on open (the engine exposes a separate `fork` command); that is pre-existing and out of this change's scope.

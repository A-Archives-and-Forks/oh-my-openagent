# Issue 5806 verification

Explicit ULW activation persists in per-hook, 256-session bounded state.
Existing guards, FIFO eviction, cleanup, and the pure model resolver remain
unchanged. Ordinary follow-ups add one durable synthetic activation marker
rather than copying the directive. The production compaction hook resolves an
active source into compaction context before OpenCode's autocontinue hook adds
its synthetic resume; it never calls `session.prompt`. The later
`session.compacted` event still invalidates the source, so the next ordinary
user turn refreshes full guidance once. Model-family changes do the same.

## Checks

- Failing first: the new compaction lifecycle, compaction-context,
  combo-only allowlist, and image-only marker tests failed: 21 pass / 4 fail
  across 25 tests (`red-continuity-seams.txt`).
- The same focused command passed 25 / 0 (`green-continuity-seams.txt`).
- `bun test --timeout 20000 packages/omo-opencode/src/hooks/keyword-detector packages/omo-opencode/src/index.compacting.test.ts packages/omo-opencode/src/plugin/chat-message.test.ts packages/omo-opencode/src/plugin/event.test.ts`: 179 pass / 0 fail across 12 files (`green-related-tests.txt`).
- Bun 1.3.14: `bun run typecheck` exited 0 (`typecheck-continuity.txt`), and
  `bun run build` exited 0 with `build: all steps completed`
  (`build-continuity.txt`).
- The language-server tool cannot inspect this sibling worktree; the complete
  compiler run above validates every changed TypeScript source file.

## Real harness capture

Real OpenCode 1.18.4 loaded a PluginModule wrapping the production keyword
hook, compaction handler, autocontinue handler, event dispatcher, pure model
resolver, and common stop owner. The driver subscribes before triggering
`/summarize` with `auto: true`; it waits for the compaction receipt,
autocontinue receipt, SSE `session.compacted`, and the fake-provider request
that follows automatic resume. The exact sanitized result records
`markerDelivered: true`, `compactionGuidanceDelivered: true`,
`autoResumeDelivered: true`, and `autocontinue.enabled: true`.

Two HTTP turns prove activation and compact retention; after compaction, the
next ordinary turn restores full guidance and its follow-up uses a marker. The
native command stops continuation, and a subsequent message remains ordinary.
After reactivation, `deletion.routed` and `deletion.cleared` prove dispatcher
cleanup. Only model responses are scripted. The disposable ARM64 Docker
container mounts only synthetic QA artifacts, uses private HOME/XDG roots, and
is removed after the run. Marker turns assert `originalTextPreserved: true`
and `addedParts: 1`; no prompt prose or prompt length is pinned.

## Reproduce and inspect

Prepare the `omo-qa` image using the repository's
[Docker QA setup](../../../.agents/skills/opencode-qa/references/docker-qa.md),
install repository dependencies, and select a compatible Bun on PATH. From the root:

```sh
bash .omo/evidence/20260908-5806-ultrawork-followups/commands.sh
```

The committed [commands.sh](commands.sh), [adapter.ts](adapter.ts),
[build.ts](build.ts), and [run.mjs](run.mjs) are the actual replay files.
[result.json](result.json) is the exact structured capture.
[isolation.txt](isolation.txt) records the before/after
`SELECT count(*) FROM session` query against the host database resolved by
`opencode db path`; the replay asserts the counts are equal.

This covers the changed hook contract, not probabilistic model compliance or
full adapter bootstrap. The temporary bundle, raw prompts and unrelated logs
are omitted; no credentials or personal configuration were copied.

# Corrections following the review of 4b42ec544

The fresh ultrabrain review rejected three reproducible issues. No external review
comments or reviewer requests were posted.

## Literal credentials

Before the fix, the actual AuthStorage consumer turned `!printf OMO_LITERAL_KEY`
into `OMO_LITERAL_KEY`, resolved `$OMO_UNSET_LITERAL` / `${OMO_UNSET_LITERAL}` to
undefined, and expanded `prefix$HOME`. The import now encodes those strings as
native literals. Existing native credentials are not rewritten. The same encoder
is used before provider-expression translation.

The regression reads the emitted auth.json with the real AuthStorage and
getApiKey(includeFallback=false), verifying exact original credential bytes.
Both newly rebuilt compiled and Node launchers also pass this assertion in
verify.mjs, recorded in compiled-consumer-qa.json and consumer-qa.json.

## Changes during consent

Three tests subscribe to the actual readline consent prompt through injected TTY
streams. A queued microtask changes auth.json, mcp.json, or creates AGENTS.md
before supplying `y`. There are no sleeps or polling delays.

Before the fix all three calls succeeded and overwrote the concurrent edit.
After the fix all three abort before writes, preserve the changed target bytes,
and leave the other targets absent. The check compares planned auth/MCP bytes
and the planned absence of AGENTS.md after consent; new-skill destinations retain
their existing pre-write existence check.

## Durable reports

Tests apply once, add an unsupported codegraph setting, and apply again. The new
warning must appear in opencode-migration-report.json. Removing it removes the
warning; unchanged reruns preserve report bytes and backup-directory counts.
This is also verified through both actual launchers.

Source warnings are re-evaluated on every run. Equal existing/imported leaves
are not conflicts. The durable report keeps last-applied action rows when no
configuration changes, and compares semantic content without volatile backup
paths or transient no-op status wording.

## Results

- Initial two-file RED: 11 pass, 9 fail. All failures matched the three findings.
- Focused GREEN: 20 pass, 0 fail.
- Complete native suite on exact Bun 1.4.0: 383 pass, 0 fail, 1156 assertions.
- Rebuilt real darwin-arm64 binary: exit 0, 110490866 bytes, 751 sidecars.
- Updated real CLI/consumer harness: PASS for both binary and Node entrypoint.
- Native tsc: the same six preexisting node:sqlite diagnostics, no new errors.
- diff --check: clean.

All fixture credentials are fabricated. No authentication provider was contacted.
The previous review worktree was removed after its result was received.

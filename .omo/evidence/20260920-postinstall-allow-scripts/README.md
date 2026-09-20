# QA evidence — 20260920-postinstall-allow-scripts (npm allow-scripts root cause)

## WHAT WAS TESTED
Whether npm 11.17.0 blocks omo-ai's postinstall or merely warns with stock settings.
Two isolated installs of the exact `omo-ai@5.0.0-0.beta.79` release: one with scripts
enabled and `--foreground-scripts`, one with `--ignore-scripts`. Both used empty
user/global npm configuration, isolated HOME, and separate cache/prefix directories.

## WHAT WAS OBSERVED
Both installs exited 0. The scripts-enabled install printed:

```text
> omo-ai@5.0.0-0.beta.79 postinstall
> node bin/senpi-patch.mjs
npm warn allow-scripts 1 package has install scripts not yet covered by allowScripts:
npm warn allow-scripts   omo-ai@5.0.0-0.beta.79 (postinstall: node bin/senpi-patch.mjs)
```

The installed engine's `dist/modes/rpc/rpc-mode.js` contained
`errorCode: "invalid_stream_event"` only in the scripts-enabled install, not in
the `--ignore-scripts` control. This is an observable effect of the omo-ai patch.

Correction: the earlier version-string oracle was invalid. The exact published
engine already contains `claudeCodeVersion = "2.1.251"` even with scripts disabled.
The old claim that it shipped `2.1.75` confused a local source checkout with the
published artifact. The conclusion holds for npm 11.17.0 stock settings, but that
version string never proved it.

## WHY IT IS ENOUGH
The lifecycle transcript and the RPC guard difference agree, with an exact-version
negative control. Reproduction commands and observations are in
`../20260920-pr8538-remediation/postinstall.md`.

## WHAT WAS OMITTED
npm 12.x and explicit allow/deny policy configurations were not tested. Do not
generalize this result to all npm versions or to installations with scripts disabled.

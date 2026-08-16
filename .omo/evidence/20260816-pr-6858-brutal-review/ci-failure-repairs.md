# Repaired-head CI failure analysis

The first repaired-head workflow was run `31925417976`.

## Codex Windows

- Failed job: `95112165293`
- Actual failing test: `packages/omo-codex/src/install/install-codex-git-bash-preflight.test.ts`
- RED: first successful non-Windows installer case timed out at `60016ms`.
- Root cause: the platform-branch assertion used `repoRoot: process.cwd()` and copied the full checkout under Windows suite contention.
- Fix: use `createRepoWithBuiltComponentBins()` with owned teardown; timeout unchanged.
- Local GREEN: focused file completed 6/6 in `744ms`; full Codex gate completed 519/519.

## Senpi Windows

- Failed job: `95112165321`
- RED: first two `/memory` tests timed out at `5016ms`.
- Root cause: Bun 1.3.12 restores its 5-second default between files in a multi-file invocation; Windows timed out during the real Git fixture's initial commit before `/memory` executed.
- Fix: file-local 30-second Windows circuit breaker, preserving 5 seconds elsewhere.
- Local CI-Bun GREEN: the exact two-file invocation completed 9/9 in `1.55s`; full Senpi gate completed 1568/1568.

## Windows console probe

- Failed job: `95112165297`
- RED: the probe exited 1, but the test asserted status before exposing captured stdout, so the deciding payload was hidden.
- Root cause: `MainWindowHandle` was used as a hosted-CI contract and the positive control lacked a fail-sensitive separate-console topology.
- Fix: expose status/signal/error/stdout/stderr on failure; use identical detached positive/negative topology; assert console allocation through Win32 `AttachConsole`; retain `MainWindowHandle` for interactive desktop proof; subscribe before shutdown and await process `close`.

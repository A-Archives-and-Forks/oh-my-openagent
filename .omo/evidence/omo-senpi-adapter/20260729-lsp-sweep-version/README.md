# Senpi LSP stale-version sweep version wiring and isolation

## What was tested

This QA covers the Senpi startup process sweep after wiring the packaged LSP
daemon version into `sweepStaleLspDaemonVersions`, isolating runtime resolution
to that cleanup family, and stabilizing the diagnostics freshness integration
coverage that failed on the loaded macOS runner.

### Regression test red phase

Command:

```sh
bun test \
  /home/minpeter/.local/share/oh-my-openagent-senpi-pr/packages/omo-senpi/src/components/task/process-sweep.test.ts
```

Observed before the implementation:

```text
error: stale-version sweep was not called
5 pass
1 fail
```

This proves the session-start path did not honor the injected packaged-version
resolver and family sweep dependencies before the wiring seam was implemented.

### Cleanup isolation red phase

Command:

```sh
bun test packages/omo-senpi/src/components/task/process-sweep.test.ts
```

Observed before moving daemon resolution into the stale-version family:

```text
error: unrelated cleanup families did not complete
6 pass
1 fail
```

The injected daemon resolver threw before the three family-level best-effort
boundaries started, reproducing the review finding.

### Targeted regression test

Command:

```sh
bun test \
  /home/minpeter/.local/share/oh-my-openagent-senpi-pr/packages/omo-senpi/src/components/task/process-sweep.test.ts
```

Observed after the implementation:

```text
7 pass
0 fail
9 expect() calls
```

The added assertion dispatched the real `session_start` handler, resolved the
distinct `"9.8.7"` sentinel through the packaged-version seam, and observed
that value at the stale-version sweep dependency. The sentinel intentionally
differs from the packaged `0.1.0` version so the test fails if the injected
resolver is bypassed.

The isolation assertion also injects an unreadable daemon metadata error and
proves that CodeGraph and orphaned-proxy cleanup still complete while only the
stale-version family logs a skip.

### macOS diagnostics freshness stabilization

The failed macOS CI run expected the first pull result `stale-pull` but received
`[]` before any cache invalidation occurred. The child-process integration case
used a 60ms freshness budget, which is also the pull request timeout; under the
loaded runner the first response missed that budget.

The two pull-fallback cases now use the existing 500ms integration-test budget.
Both cases were repeated 20 times:

```text
40 pass
0 fail
120 expect() calls
```

The complete `lsp-core` package also passed:

```text
92 pass
0 fail
277 expect() calls
```

### macOS full-suite flake stabilization

The refreshed macOS run proved the diagnostics fallback fix, then exposed two
independent timing assumptions elsewhere in the root suite:

- overlapping Senpi reconciles assumed the second-started RPC child must lose
  ownership, even though either asynchronous respawn can complete first;
- the CodeGraph tree-reaping fixture gave a loaded nested Node process only
  100ms to spawn its descendant and write `survivor.pid`.

The reconcile failure reproduced locally 20 times in 1,000 runs. The corrected
assertion verifies the actual invariant: exactly one child is terminated and
disposed, and the surviving child remains the manager owner regardless of
start order.

```text
1000 pass
0 fail
5000 expect() calls
```

The CodeGraph fixture now starts a readiness listener before spawning the
command. After the descendant writes its PID and signals that listener, the
test resolves an injected timeout trigger that runs the same process-tree
termination path as the production timer. The standard `AbortSignal` listener
is removed when the command settles. This removes wall-clock startup from
the asserted behavior.

```text
100 pass
0 fail
200 expect() calls
```

Affected package gates:

```text
senpi-task: 1035 pass, 0 fail
codegraph-bootstrap: 21 pass, 0 fail
workspace typecheck: exit code 0
```

After materializing the repository's ignored build prerequisites with
`bun run build`, the full root suite passed:

```text
12518 pass
3 skip
0 fail
42864 expect() calls
```

After fetching `origin/dev`, the branch was already current:

```text
behind 0, ahead 5
```

### Senpi package typecheck

Command:

```sh
bun run --cwd /home/minpeter/.local/share/oh-my-openagent-senpi-pr/packages/omo-senpi typecheck
```

Observed result: exit code 0 with no diagnostics.

### Complete Senpi package gate

Command:

```sh
bun run --cwd /home/minpeter/.local/share/oh-my-openagent-senpi-pr test:senpi
```

Observed result:

```text
490 pass
0 fail
1371 expect() calls
```

The gate rebuilt the packaged daemon and regenerated Senpi extension artifacts,
ran the adapter typecheck, and ran all 78 Senpi test files.

### Real Senpi TUI startup

The built PR plugin was installed into the isolated agent directory:

```text
/home/minpeter/.cache/omo-pr-lsp-sweep-qa-20260729
```

`OMO_LSP_DAEMON_VERSION` and `OMO_LSP_DAEMON_CLI` were explicitly unset before
launching the real `senpi --no-session` TUI.

Observed result:

```json
{"badge":true,"staleVersionWarning":false,"unknownVersion":false,"undefinedSuffix":false}
```

The rerun again rendered:

```text
(🏴‍☠️ OmO Native)
```

### Real Senpi RPC startup

The real `senpi --mode rpc --no-session` process was launched with the same
isolated agent directory and without either LSP daemon override variable. A
`get_commands` request confirmed the built plugin loaded its task surface.

Observed result:

```json
{"tasks":true,"staleVersionWarning":false,"unknownVersion":false,"undefinedSuffix":false}
```

The successful `get_commands` response reported both `tasks` and `task-kill`
from the PR worktree's generated `omo.js`.

## Why this is enough

- The red/green regression test proves the stale-version sweep receives the
  packaged version.
- The resolver-failure regression proves LSP packaging failures cannot suppress
  the independent CodeGraph and orphaned-proxy cleanup families.
- The repeated diagnostics fallback cases and complete `lsp-core` package gate
  cover the macOS CI failure without changing production timing behavior.
- The complete package gate covers the generated extension bundle and all
  Senpi adapter behavior.
- The real TUI and RPC launches prove that the built plugin starts without the
  version-unknown warning when no environment-variable workaround is present.
- The QA agent directory is isolated from the user's configured Senpi agent
  directory.

## Omitted material

Raw TUI escape sequences, environment dumps, session files, credentials, and
other secret-bearing runtime logs were not recorded. Only the sanitized
boolean observations above are retained.

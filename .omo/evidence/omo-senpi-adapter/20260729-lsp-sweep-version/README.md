# Senpi LSP stale-version sweep version wiring

## What was tested

This QA covers the Senpi startup process sweep after wiring the packaged LSP
daemon version into `sweepStaleLspDaemonVersions`.

### Regression test red phase

Command:

```sh
bun --cwd /home/minpeter/.local/share/oh-my-openagent-senpi-pr test \
  packages/omo-senpi/src/components/task/process-sweep.test.ts
```

Observed before the implementation:

```text
SyntaxError: Export named 'sweepOmoFamiliesBestEffort' not found
0 pass
1 fail
```

This proves the new regression test could not pass against the pre-fix
implementation.

### Targeted regression test

Command:

```sh
bun --cwd /home/minpeter/.local/share/oh-my-openagent-senpi-pr test \
  packages/omo-senpi/src/components/task/process-sweep.test.ts
```

Observed after the implementation:

```text
6 pass
0 fail
7 expect() calls
```

The added assertion observed `currentVersion === "0.1.0"` at the stale-version
sweep dependency.

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
489 pass
0 fail
1369 expect() calls
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

### Real Senpi RPC startup

The real `senpi --mode rpc --no-session` process was launched with the same
isolated agent directory and without either LSP daemon override variable. A
`get_commands` request confirmed the built plugin loaded its task surface.

Observed result:

```json
{"tasks":true,"staleVersionWarning":false,"unknownVersion":false,"undefinedSuffix":false}
```

## Why this is enough

- The red/green regression test proves the stale-version sweep receives the
  packaged version.
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

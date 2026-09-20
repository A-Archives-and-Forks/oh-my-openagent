# Launcher parity red state

## What was tested

Before the dispatcher implementation, I ran:

```text
bun test packages/omo-native/test/compile-entry.test.ts
```

The two new compiled-entry tests invoke `runCompiledLauncher()` with isolated
HOME, XDG, and OMO/SENPI agent-directory variables. One supplies a disposable
OpenCode API entry to `setup --yes`; the other supplies a disposable OpenCode
model to `migrate --yes`.

## What was observed

The command exited `1` under Bun `1.3.14`. The new tests failed because the
compiled setup path only rendered a report and the compiled migrate path fell
through to the engine, so neither expected target file was created.

## Why this is sufficient

The failures require real output files (`auth.json` and `settings.json`), not a
mocked dispatch assertion. They isolate every writable runtime location and
therefore identify the compiled-entry routing gap directly.

## Omitted

The fixtures use only dummy values. No credential values, user configuration,
or environment dump is retained here.

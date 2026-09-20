# Focused launcher regression receipt

## What was tested

```text
bun test packages/omo-native/test/compile-entry.test.ts \
  packages/omo-native/test/migrate.test.ts \
  packages/omo-native/test/setup-import.test.ts
```

## What was observed

The focused suite exited `0` under Bun `1.3.14`. It includes the new compiled
setup and migrate real-write regressions plus the npm-launcher migration and
setup import coverage.

## Why this is sufficient

The suite covers both entrypoints through filesystem-observable behavior:
setup imports a disposable API entry and migrate creates translated settings.
It also retains the existing dry-run behavior regressions for the npm
launcher.

## Omitted

Verbose setup reports and test fixture contents are omitted. The suite used
only temporary HOME/XDG/agent directories and dummy values.

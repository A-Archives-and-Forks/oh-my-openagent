# Memory pressure dream origin QA

Date: 2026-08-18
Branch: `feat/memory-pressure-dream-origin`
Base: `origin/dev` at `5b60be0e8`

## Dependency setup

`bun install --frozen-lockfile` completed successfully, including the workspace postinstall/build. No `node_modules` symlink fallback was used.

## RED

Focused TDD run before implementation:

```text
3 tests failed:
- pressure past spacing was rejected as insufficient_volume
- soft-threshold status refresh made zero pressure requests
- pressure fire with no transcripts made zero reservations
37 pass, 3 fail
```

Full output: [`red.txt`](./red.txt)

## GREEN

The final affected suite covers memory-core reservation arbitration, every existing dream origin, the new pressure gate and empty-transcript reservation path, status threshold/dedupe behavior, bind-time wiring, identity runtime, completion/reconciliation, and supervisor metadata.

```text
133 pass
0 fail
989 expect() calls
```

Full output: [`green-tests.txt`](./green-tests.txt)

## Type checks

- `packages/omo-senpi`: `npx tsgo --noEmit -p tsconfig.json` - PASS
- `packages/memory-core`: `npx tsgo --noEmit -p tsconfig.json` - PASS

Outputs:

- [`tsgo-omo-senpi.txt`](./tsgo-omo-senpi.txt)
- [`tsgo-memory-core.txt`](./tsgo-memory-core.txt)

## Bundle verification

`node packages/omo-senpi/plugin/scripts/build-extension.mjs` completed and `git diff --exit-code -- packages/omo-senpi/plugin/extensions` confirmed the committed generated bundles are current.

Full output: [`bundle-build.txt`](./bundle-build.txt)

## Acceptance mapping

- `DreamOrigin` includes `pressure`; reservation, spawn, run-ledger, and completion parsing accept it.
- Threshold is `floor(MEMORY_PRESSURE_SOFT_RATIO * compileWarnTokens)` using the existing constant.
- Pressure obeys `dream.enabled` and shared `min_hours_between`, but does not probe transcript volume or wait for idle.
- Pressure reserves through the existing `ReflectionReservationStore.tryReserve` path with an empty transcript selection, so memory-tree compaction can run without unreflected transcript bytes.
- Status warning copy and full advisory threshold are unchanged.
- Bind-refresh wiring test observes exactly one pressure reservation at the soft threshold; direct status tests cover under-threshold and already-notified dedupe paths.
- Existing manual, idle, and shutdown suites remain green.

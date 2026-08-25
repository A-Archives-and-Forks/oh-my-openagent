# Dev failure repair evidence — 2026-08-25

Base: `origin/dev` at `d2132a6d1`

## Baseline

`bun test packages/omo-senpi` initially produced 2,219 passes, 13 failures, and 1 Windows-only skip.
The failures were:

- `cli-local` isolated agent-directory settings round-trip
- session-start ordering/onboarding bootstrap
- ten init-deep-advisor state/choice/timer cases
- native product identity explicit-agent-directory path

The other baseline suites and all three TypeScript checks were green.

## Root causes and fixes

All 13 initial failures shared test-environment contamination: the fixtures set only
`SENPI_CODING_AGENT_DIR` while `OMO_CODING_AGENT_DIR` has higher resolver precedence. Test fixtures
now set and restore all three supported agent-directory variables.

The remaining SemVer test required an obsolete date-shaped version. It now accepts the packaged
SemVer display contract, including prerelease/build metadata.

The real Senpi QA harness additionally lacked hermetic child startup configuration. It now isolates
the three agent-directory variables, HOME/USERPROFILE, XDG config/data/cache, and sets `PI_OFFLINE=1`
so QA cannot perform uncontrolled network package installation.

The build-extension freshness test had a 30-second budget for two six-artifact builds and timed out
under the package suite. Its local budget is now 60 seconds; focused runs prove the assertion itself.

## Final proof

- Focused repaired failure tests: 35 pass, 0 fail.
- Full `test:senpi`: 2,232 pass, 1 Windows-only skip, 0 fail, 2,233 total.
- Senpi QA resolver gate: 10 pass, 0 fail.
- Real ultrawork QA: PASS (`ultraworkInjected=true`, `hiddenInjectionOk=true`, clean user text,
  real agent home untouched).
- Real Senpi QA: PASS (`ultraworkInjected=true`, `commentChecker=PASS`, real agent home untouched).
- TypeScript diagnostics: no errors on all changed TypeScript files.
- Parallel-only CodeGraph and staging timeouts were reproduced green in isolation twice and classified
  as host contention, not source regressions.

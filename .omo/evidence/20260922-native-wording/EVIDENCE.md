# QA evidence — omo #8618: OmO Native wording + public `--platform=native`

Date: 2026-09-22 · Branch: `fix/8618-omo-native-wording` · Base: `dev` @ 6885e24ad

Driver: `qa-real-surface.sh` (in this directory, re-runnable). Every scenario runs
under `env -i` with `HOME` and all four `XDG_*` roots pointed at a fresh `mktemp -d`
sandbox, and with fake `bun` / `npm` shims on `PATH` that only echo their argv. No
global package was installed and no real `~` state was read or written.

## WHAT WAS TESTED / WHAT WAS OBSERVED

| # | Surface driven | Observed | Artifact |
|---|---|---|---|
| a | `bun packages/omo-opencode/src/cli/index.ts install --no-tui --platform=opencode --claude=no --gemini=no --copilot=no --skip-auth` | exit 0. Hint box titled `OmO Native (beta)`, body "omo also ships as OmO Native: the same omo as one omo command, with no OpenCode host required.", `bun add -g omo-ai@beta`, "This install keeps working as-is.", guide URL ending `#omo-native-beta-omo-via-omo-ai` | `qa-a-installer-hint.txt` |
| b | `node postinstall.mjs` | exit 0. `oh-my-openagent: OmO Native (beta) is the same omo as one 'omo' command, with no OpenCode host: bun add -g omo-ai@beta` | `qa-b-postinstall.txt` |
| c | `install --help` with no env flag | `--platform <platform>  Install target platform: opencode, codex, both, native (choices: "opencode", "codex", "both", "native")` — `native` is public, `native-dev` absent | `qa-c-install-help.txt` |
| d | `install --no-tui --platform=native`, fake `bun` first on PATH | exit 0. `FAKE-bun ARGV: add -g omo-ai@beta`, then `[OK] OmO Native installed. Run omo setup to finish onboarding.` Summary line reads `OmO Native: installing from omo-ai@beta` | `qa-d-platform-native-bun.txt` |
| e | same, PATH carrying only a fake `npm` | exit 0. `FAKE-npm ARGV: i -g omo-ai@beta`, then `bun is the recommended runtime for OmO Native; npm works, but bun is what the beta channel is tested on.` | `qa-e-platform-native-npm.txt` |
| f | same as (d) with `FAKE_PM_EXIT=7` | exit 1, no raw throw. `[X] OmO Native install failed: bun exited with code 7` / `[X] Install it yourself with: bun add -g omo-ai@beta` / `[X] Then run omo setup.` | `qa-f-platform-native-failure.txt` |
| g | `install --no-tui --platform=native-dev`, no env flag | exit 1, refused: `argument 'native-dev' is invalid. Allowed choices are opencode, codex, both, native.` | `qa-g-native-dev-refused.txt` |
| h | `install --help` with `OMO_ENABLE_NATIVE_DEV_PLATFORM=1`, then with legacy `OMO_ENABLE_SENPI_PLATFORM=1` | both list `native-dev` in the choices, so the legacy variable still works as an alias | `qa-h-native-dev-help.txt` |

Verdict line from the driver: `VERDICT=PASS (no banned edition wording in any captured surface)`
— a `grep -rniE 'senpi[ -]*(native[ -]*)?edition|standalone senpi'` over every captured
file returns nothing, while `OmO Native` appears in a, b, d, e and f.

## AUTOMATED GATES

| Gate | Result | Artifact |
|---|---|---|
| `bunx tsgo --noEmit -p packages/omo-opencode/tsconfig.json` | `TSGO_EXIT=0` | `GATE-tsgo.txt` |
| `bun test packages/omo-opencode/src/cli/ postinstall.test.ts` | `BUNTEST_EXIT=0`, 772 pass / 0 fail | `GATE-bun-test.txt` |
| `bun test packages/omo-opencode/src/cli/native-wording-guard.test.ts` — RED before the rename | 33 banned-wording violations + the engine-mention list, naming every offending file:line | `RED-native-wording-guard.txt` |
| same guard, after the rename | 17 pass / 0 fail | `GATE-bun-test.txt` |
| `install-native` per-assertion mutation pass | 5 claims, each mutation failing exactly its own assertion; one first-round mutation was an equivalent mutant and is recorded as such | `MUTATION-install-native.txt` |

## WHY IT IS ENOUGH

The regression guard scans the same surface set the issue names (installer sources,
`postinstall.mjs`, `docs/guide/installation.md`, `README.md` + the four translations),
rejects the banned edition wording in all five README languages with no allowlist
escape, and requires every surviving `senpi` mention to match an explicit engine-name
allowlist — so the wording cannot drift back silently. Its own detectors are covered
by positive and negative cases, including one that proves the allowlist does not excuse
a bare edition mention. The `--platform=native` install is proven on the real CLI in all
three branches that matter (bun, npm fallback, non-zero exit) with the package manager
observed by argv rather than mocked away, and the failure branch is proven to report
instead of throw. `install --help` is the actual Commander output, not a source grep.

Residual risk: the guard cannot see surfaces outside its scan list, and `omo.json`'s
`[senpi]` harness block plus the `omo-senpi-*` reviewer agent names remain public
contracts that need an alias window — deliberately out of scope here and tracked
separately in the #8618 cluster.

## WHAT WAS OMITTED

No tokens, credentials, auth headers, env dumps or machine identifiers appear in any
artifact: the sandbox is built with `env -i` and only the variables listed above, and
the fake package managers echo argv only. Sandbox paths are macOS temp dirs and were
removed at the end of the run (`cleanup: ... -> REMOVED`, plus a `REMOVED` receipt for
the scenario-h sandbox).

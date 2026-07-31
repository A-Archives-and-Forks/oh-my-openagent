# PR #6521 Windows CI repair

## What was tested

- Failed GitHub Actions run `30627980408`, `test (windows-latest)`.
- A failing-first file-URL regression.
- The focused audit, script typecheck, no-excuse rules, and full root suite
  under CI's Bun 1.3.12.
- The replacement GitHub PR check surface; final output is recorded in
  `CI-GREEN.txt`.

## What was observed

- Windows failed before scanning because `.pathname` produced a non-native
  `/D:/...` working directory for `Bun.spawn`.
- macOS and Ubuntu passed, ruling out a real retired-model reference.
- The local regression failed with `%20` encoded, then passed with
  `fileURLToPath`.
- The repository scan once hit Bun's five-second default after 5.00 seconds
  and passed diagnostically in 4.28 seconds. A 20-second circuit-breaker makes
  the repository-wide scan deterministic without timing-based synchronization.
- The final full suite passed 12,626 tests with zero failures.

## Why it is enough

- The GitHub stack, OS split, and regression identify the boundary.
- GREEN runs real `git ls-files`, `stat`, and file reads without mocks.
- Typecheck, no-excuse validation, and the full suite cover adjacent script and
  repository behavior.
- GitHub Actions is the authoritative Windows acceptance surface.

## Senpi surface scope

This repair changes only `script/`; it does not alter the Senpi runtime in PR
#6521. The original PR's xterm.js/Chromium TUI evidence is at
`.omo/evidence/20260731-senpi-ulw-goal-footer/SUMMARY.md` in its task
worktree. Repeating that TUI would not exercise Windows path conversion.

## What was omitted

- Secrets, raw environment dumps, and full logs.
- A local Windows VM: GitHub Actions supplies the authoritative RED and GREEN.
- Sibling-worktree LSP diagnostics, which the registered tool rejects; script
  `tsgo` was used instead.


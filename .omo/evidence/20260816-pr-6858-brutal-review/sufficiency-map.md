# PR #6858 evidence sufficiency map

## Review submission

| Requirement | RED | GREEN |
|---|---|---|
| No existing owner REQUEST_CHANGES review | `review-red.json` | `review-response.json`, `review-green.json` |
| Literal API payload and blocker traceability | `branch-baseline.txt` | `review-request.json`, review id `4945309647`, inline comments `3790854396` and `3790854406` |

## Submitted blockers

| Blocker | RED artifact | GREEN artifact |
|---|---|---|
| Generated bundle conflicted with current `dev` | `merge-red.txt` | `merge-green.txt`, `bundle-green.txt`, `local-verification.txt` |
| Current PR head lacked CI | `ci-red.json` | Final repaired-head workflow link and check rollup will be added after the force-with-lease push |
| Windows evidence was prose-only and did not isolate the agent directory | `evidence-red.txt` | Canonical `windows-console-probe.ts`, `windows-console-inspection.ts`, final Windows payload, and cleanup receipt |
| Production `execution_mode: "process"` route was dismissed as in-process | `routing-red.txt` | `routing-green.json`, `routing-sufficiency.md` |
| PR body used obsolete evidence paths | `evidence-red.txt` | Final PR body snapshot after canonical link replacement |

## Required local gates

`local-verification.txt` records:

- 118/118 runnable Senpi runner tests green.
- Senpi-task, omo-senpi, and omo-codex typechecks exit 0.
- Exact Bun 1.3.12 generated bundle check exit 0.
- Full Senpi gate: 1568 pass, 0 fail.
- Full Codex gate: 519 pass, 0 fail.
- Changed-file LSP diagnostics clean.
- Changed files below 250 pure LOC.

## Real surfaces

- Codex installer: `codex-install-qa.txt`
- Production Senpi RPC routing: `routing-green.json`, `routing-sufficiency.md`
- Windows hosted process allocation: pending final repaired-head Windows payload.
- Interactive Windows `MainWindowHandle`: pending unlocked-desktop smoke.

## Cleanup and omissions

- No environment dump is retained.
- Real credential contents, auth headers, model tokens, and private config bodies are omitted.
- Final worktree, LSP symlink, Windows guest copy, temporary probes, and process cleanup receipts will be added before merge.

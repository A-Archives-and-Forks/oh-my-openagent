# Prompt Contract Test Removal Evidence

## Baseline

- Host: `mengmotaHost` (`Mac16,11`, 14 cores).
- Worktree:
  `/Volumes/mengmotaStorage/local-workspaces/omo-wt/chore-remove-prompt-contract-tests`
- Branch: `chore/remove-prompt-contract-tests`
- Base: `origin/dev` at `3dd88267f87bd47795d3eea7782e676bb40e2f9b`.
- Shared checkout was dirty and was not modified.

## Evidence contract

Each artifact records the exact command, observed output, binary PASS/FAIL
condition, and any cleanup receipt. Raw secret-bearing logs are excluded.

## Prompt-contract scanner

`audit_prompt_contracts.py` enumerates tracked JavaScript/TypeScript
`*.test.*` and `*.spec.*` paths directly from `git ls-files`; no path manifest
or allowlist controls discovery. It invokes `prompt_contract_ast.mjs`, which
uses the installed TypeScript 6.0.3 compiler API to parse each present
working-tree test and follows assertion literals through variables, arrays, `for...of` bindings,
boolean `.includes()` expressions, matcher chains, order-helper calls, derived
heading/token arrays, `indexOf` ordering, `startsWith` aliases, regex-derived
presentation checks, and authored-text non-empty assertions. Tracked paths
deleted in the working tree remain in the
2,291-file enumeration and are reported separately as `tracked-missing`.

Candidates are joined to `prompt-contract-classification.json` by a SHA-256
fingerprint over path, candidate kind, matcher, actual expression, and expected
value. Fingerprints do not contain line numbers. Allowed and forbidden entries
must include one of the scanner's explicit seam categories and a non-empty
rationale. Unclassified, forbidden, or stale classifications make the command
exit nonzero.

Commands:

```sh
python3 .omo/evidence/20260817-remove-prompt-contract-tests/test_audit_prompt_contracts.py -v
python3 .omo/evidence/20260817-remove-prompt-contract-tests/audit_prompt_contracts.py --compact
```

The second command is intentionally red while the exact inventory in
`current-prompt-contract-audit.txt` still contains candidates requiring lead
disposition. A nonzero result is not converted to green by path omission or
blanket classification.

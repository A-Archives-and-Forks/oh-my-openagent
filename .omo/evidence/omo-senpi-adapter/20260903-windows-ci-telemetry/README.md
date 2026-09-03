# Windows CI Telemetry Evidence

## What was tested

- TDD RED:
  `bun test script/ci-root-test-partition.test.ts` against the contract before
  telemetry implementation.
- Contract GREEN:
  `bun test script/ci-root-test-partition.test.ts`.
- Required local gate:
  `bun test script/ci-root-test-partition.test.ts script/ci-fast-path.full-matrix.test.ts`.
- Workflow validation:
  `actionlint -shellcheck= .github/workflows/ci.yml`. The repository's workflow
  lint configuration disables shellcheck and validates the Actions/YAML
  contract.
- TypeScript review:
  LSP diagnostics and the programming skill's
  `check-no-excuse-rules.ts` against `script/ci-root-test-partition.test.ts`.
- Senpi QA:
  `node packages/omo-senpi/scripts/qa/drive.mjs --self-test`,
  `node packages/omo-senpi/scripts/qa/drive.mjs`,
  `tsgo --noEmit -p packages/omo-senpi/tsconfig.json`, and
  `bun run test:senpi`.

## What was observed

- RED failed for the intended reason with the exact diagnostic:
  `windows telemetry contract: missing post-test capture`.
- The focused GREEN run passed 15 tests with 81 expectations.
- The final required two-file run passed 36 tests with 139 expectations.
- `actionlint -shellcheck=` exited 0 with no output.
- The strict TypeScript audit reported no violations.
- The Senpi driver self-test reported `SELF-TEST OK`.
- The live Senpi driver reported `PASS`, proved ultrawork injection and comment
  checking, used an isolated temporary agent directory, and reported both the
  real `~/.senpi/agent` and `~/.omo/agent` untouched.
- The Senpi package gate passed 2,537 tests with one declared skip and zero
  failures, then passed all 10 evidence-resolver tests.

## Why it is enough

The contract tests pin the machine-consumed workflow and collector invariants:
all three Windows Bun invocations use the telemetry wrapper, the wrapper records
pre/post QPC and UTC timing plus allowlisted process and temporary-path data,
the Bun exit code remains authoritative, and a uniquely named artifact uploads
from an `always()` step with telemetry failures marked non-gating. The live
Senpi run proves the CI-facing Senpi surface still loads through the real
harness in isolation. Native Windows artifact evidence will be added after the
draft PR's required Windows matrix run.

## What was omitted

Raw environment dumps, command lines, credentials, tokens, cookies, and full
host logs were not captured. The evidence records only allowlisted process
metadata, temporary paths, exit status, selected isolation fields, and
reviewer-relevant command summaries.

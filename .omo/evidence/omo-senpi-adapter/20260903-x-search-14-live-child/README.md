# Todo 14 live child evidence

This sibling evidence directory records the live child QA runs for todo 14.

- `quick.json` records the quick child lane with an observed `x_search results:` header.
- `librarian-attempts.json` records every librarian attempt (verdict and `xSearchResults` per attempt); `librarian.json` is the selected passing run.
- `explore.json` records zero `x_search results:` headers. The explore denial observation is pending the c13-final driver update: this directory must not treat scripted prose as proof. The builtin denylist unit pin remains in `packages/senpi-task/src/agents/builtin/builtin-agents.test.ts` (explore has no `x_search` rule).
- `unit-test.txt` is the raw combined Bun transcript for the three required test files.
- `green.txt` records the test command and raw pass/fail/expect counts.

All persisted transcripts are scrubbed before saving. The isolated credential copy is shredded by the driver after each run; no token values are included here.

# RED -> GREEN - a POSIX default-timeout clobber on dev

## RED

The post-merge `dev` run for PR #6713 failed on `test (macos-latest)` only:

```text
3 tests failed:
(fail) production prompt injection routes > ... only the shared gate may call raw OpenCode prompt APIs [5017.61ms]
  ^ this test timed out after 5000ms.
(fail) production prompt injection routes > ... every route declares queue behavior explicitly
(fail) production prompt injection routes > ... every retry caller declares queue behavior explicitly
Ran 14145 tests across 1835 files. [355.74s]
```

Run: https://github.com/code-yeongyu/oh-my-openagent/actions/runs/31385635588/job/93445296099

`test (windows-latest)` PASSED on that same run, so the Windows repair itself held.

## Attribution: caused by PR #6713

The previous `dev` run (4cecf37b7, PR #6700) failed on `test (windows-latest)` ONLY - macOS was green.
The macOS job turned red immediately after #6713 merged, and #6713 is the only change touching test
timeouts.

## Root cause

`bun test` runs every file in ONE process, so `setDefaultTimeout` is process-global, not per-file.
`script/package-layout.test.ts:43` raises that global default to 60_000 ms. PR #6713 added four files
that call `setDefaultTimeout(process.platform === "win32" ? 30_000 : 5_000)`, and on POSIX that
**lowers** the global default back to 5 s for every file loaded afterwards. The prompt-route audit
parses the whole production source set through the TypeScript native API, which needs more than 5 s on
a loaded macOS runner, so it was killed mid-parse; the two sibling assertions then failed on the
broken parser state.

## Fix

Delete all four per-file calls. The Windows budget they were added for is already provided globally and
safely by `test-setup.ts`:

```ts
if (process.platform === "win32") setDefaultTimeout(30_000)
```

That form only ever raises the floor on Windows and never lowers it on POSIX, so no file can shorten
another file's budget.

## GREEN (local)

```text
Ran 42 tests across 6 files. 42 pass, 0 fail
```

covering the four files whose calls were removed, the prompt-route audit that failed on CI, and the
admission-lease suite.

## Why this is enough

The failing audit runs in the same process as the four files and passes with the clobber removed, and
the remaining `setDefaultTimeout` calls in the tree are either the guarded win32 floor or pre-existing
callers unchanged by this work.

## Residual risk

Three pre-existing `memory-core` test files still use the lowering ternary form. They predate this work
and macOS was green with them, so they are left untouched here; converting them to the guarded form
would be a separate change.

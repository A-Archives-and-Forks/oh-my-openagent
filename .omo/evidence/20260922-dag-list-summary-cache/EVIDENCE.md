# DAG list() summary cache - QA evidence (#8649)

## What was tested

`DagManager.list()` in `packages/senpi-task/src/dag/manager.ts`, the function the DAG status
widget calls on every 1Hz repaint and `dag-runtime.ts:449`'s `mutationListener` calls three more
times per checkpoint write. The behaviour under test is how many checkpoint files one `list()`
call reads, and whether a cached listing still reflects filesystem truth.

- `RED-manager-list-cache.txt` - the three assertions with the production change reverted to origin/dev.
- `GREEN-manager-list-cache.txt` - the same three assertions with the change applied, plus the full `packages/senpi-task/src/dag` suite.
- `MUTATION-cache-no-revalidate.txt` - the invalidation assertion broken on purpose, to prove it can fail.
- `BENCH-list-cost.txt` - the measured cost of the old I/O pattern on a real 710-checkpoint / 68MB state dir, the stat-only steady state, and the measured cost of the `process.kill` probe that was originally suspected.
- `HARNESS-eventloop-before-after.txt` - production code driven at the widget's 1Hz cadence against that directory with a 50ms heartbeat standing in for the TUI output writer.

## What was observed

Before: one `list()` re-read and re-parsed every checkpoint in the runs directory - 710 files /
68.2MB, 473ms median - and the event loop was blocked roughly 47% of every second. After: unchanged
runs cost zero checkpoint reads, a rewritten run costs exactly one, a pruned run costs zero and
leaves the listing. In the harness, `list()` median went 105.9ms -> 2.8ms and the worst heartbeat
stall 160.7ms -> 50.3ms.

The originally suspected `process.kill(pid, 0)` probe was measured at 0.20 microseconds and left
unchanged.

## Why it is enough

The defect is a read-volume defect, so the regression coverage asserts read COUNTS rather than
durations - a timing threshold is not reproducible on a shared box (this one was at load 91). The
counting seam is the injected `DagFileStore`, so the assertion measures the real code path rather
than a stub. The cache cannot desynchronise from disk: the directory listing remains authoritative
for membership, and every checkpoint write lands as a temp+rename that allocates a new inode, so
the `(ino, size, mtimeMs)` triple changes on every write. The mutation capture proves the
invalidation assertion fails when that revalidation is removed.

## What was omitted

No live `senpi` binary session was driven for this change: it alters no tool, prompt, schema, hook
or user-visible surface, only the read volume behind an existing internal call. The real-surface
substitute is the harness above, which runs the production store and manager at the widget's own
cadence. No secrets, tokens, environment dumps or session identifiers are reproduced here; the
benchmark directory is referenced by shape (710 checkpoints / 68MB), not by path.

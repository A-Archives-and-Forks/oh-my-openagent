# Post-merge live verification - #8657 / PR #8658

Runtime: dev binary built from the merge commit `7dd8ad4fc` (its provenance line names that sha).
Surface: a real 7-node run in a real project state dir, resumed by session id from a scratch shell
after confirming no process held that session. Every row below is read from the durable checkpoint
JSON and the task records, never from a rendered widget.

## Before (six re-adoptions, gate absent)

```
checkpoint status      paused  (each resume flipped it to running)
generation             6
checkpointSeq          51
L1-thread-open         state=running   error=(none)
L7-quota-surfacing     state=running   error=(none)
run outcome            never terminal; the gate node behind them never unblocked
```

## After (same sequence, gate present)

```
checkpoint status      failed
generation             7
checkpointSeq          57
leaseHolderPid         released
L1-thread-open         state=failed  error.code=resume_task_orphaned
                       "task <id> still reads running but no child of this host backs it
                        (residency_state=rpc_detached, suspension_reason=daemon_unavailable,
                         runner_kind=host-session); its settlement can never be observed here."
L7-quota-surfacing     state=failed  error.code=resume_task_orphaned
                       "... (residency_state=resident, runner_kind=host-session, host_pid=<foreign pid>) ..."
gate                   state=skipped  (dependent cascade, unchanged behaviour)
running nodes          0
```

Both messages carry the residency evidence that explains the verdict, and both nodes remain
retryable. The run reached a terminal status for the first time in six generations.

## One row that did NOT change, and why that is correct

The acceptance table asked that the parked child's record not be re-stamped at resume time. It was
re-stamped (`updated_at` moved to the resume), and that is **outside this change**: the DAG engine
never writes task records - `recovery.ts` and `scheduler.ts` contain no record-store mutation at
all - so the re-stamp is the task lifecycle's session-start reconcile re-parking the record, which
this PR deliberately did not touch.

The same resume shows the other half of that story: the second child's record was **not** re-stamped
(its `updated_at` is unchanged from the morning), because lifecycle reconcile defers it as
`foreign_live_owner` on a signal-0 probe of a pid that is alive but no longer holds the session.
That is exactly the defect filed as #8659, visible in the same two records: one keeps being
re-parked as `running`, the other is frozen untouched. Until #8659 lands, a record can still read
`running` with nothing behind it - but a DAG node no longer inherits that claim.

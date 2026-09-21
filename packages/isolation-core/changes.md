# isolation-core changes

## The isolation PAL

Harness-neutral copy-on-write task isolation with patch and branch merge-back,
ported from oh-my-pi `crates/pi-iso` and `task/isolation-*` (MIT). Candidate
ordering, unavailable-only fallback and retention follow that upstream. The
owner protocol adds process-instance identity, daemon session ownership and
atomic publication. No Rust/napi crate and no `.node` sidecar; ProjFS stays
excluded because its driver-callback provider API needs a native callback
host, not a Bun-callable clone operation.

## Backends

APFS clonefile goes through lazy `bun:ffi` with immediate errno
classification, no-follow flags and same-device checks. rcopy builds a git
worktree and detaches its Git metadata into private storage: allowlisted
config, refs and index, alternates, lock removal, guarded admin
deletion and pruning, and nested submodule repair or refusal. btrfs and ZFS
clones record dataset and snapshot identity, fuse-overlayfs keeps the lower
path, and ReFS block-clones cluster-rounded tails on Windows. Copy walks
enforce a 2 GiB default budget with 10% target-space headroom; special
entries are skipped rather than copied.
The sandbox base directory never lands inside the repository being
isolated, even when a subvolume-style root reports its own device; the device
walk adopts the enclosing writable filesystem and otherwise falls back home.
Probing is context-bound: reflink writes its probe files inside the supplied
base directory only, and a probe without a context stays read-only instead of
writing into the source repository. Unexpected backend command failures (an
I/O error from btrfs, zfs or fsutil, a dlopen crash, a live worktree
registration that refuses removal) propagate instead of being reported as
"unavailable"; only capability failures fall through to the next backend.

## Baselines and deltas

Root and nested baselines capture staged, unstaged and non-ignored untracked
state under a default 1 GiB per-repository budget with a typed overflow
error. Git output is drained under the remaining budget and untracked sizes
are checked before rendering. Synthetic indexes reconstruct baseline and
current trees in the source object database, so binary tree diffs exclude
parent WIP and include child commits plus remaining edits. C-quoted UTF-8
paths are decoded before use.

## Merge-back

Patch apply is atomic per repository, probes reverse and forward idempotence,
and never uses `--3way` automatically; nested repositories commit
separately and partial root success is reported explicitly. Branch replay
preserves child commits on clean baselines and filters inherited WIP on dirty
ones; an unresolvable replay throws `IsolationCommitReplayError` naming the
commit and the retained branch. Every failure path retains the isolated tree
with the manual recovery command instead of deleting it. Both modes serialize
through memory-core's identity-bearing lock. Stash cycles
are tracked by entry identity: a no-op push (dirt only inside a submodule)
never touches the stack, and a pop restores exactly the entry the merge
created, never whatever landed on top afterwards. A baseline-listed nested
repository missing from the isolated tree fails the delta loudly instead of
merging back an empty change, and nested paths are checked for symlink
escapes immediately before mutation.

## CI and tests

Run focused files with `bun test packages/isolation-core/src/<name>.test.ts`;
the package suite is `bun test packages/isolation-core`, and typecheck uses
`tsgo --noEmit -p packages/isolation-core/tsconfig.json`. The Linux filesystem
workflow (`.github/workflows/isolation-linux-fs.yml`) creates real loopback
btrfs and, when the kernel module loads, ZFS pools, then exercises
publication, copy-on-write and teardown. ReFS validation on Windows follows
the runbook in AGENTS.md with `ISOLATION_TEST_REFS_ROOT`.

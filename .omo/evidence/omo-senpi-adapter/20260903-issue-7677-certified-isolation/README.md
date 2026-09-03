# Issue #7677 bounded live isolation certification

Canonical acceptance evidence for final merged source head `836f37cce8ba2865eea213889dacd01b699d40f7`. Source implementation was committed separately at `0d003f8ab6db96c4f32035146ff028ed3a147109`; `origin/dev` advanced during verification, was merged at `c07e5cb3b`, and the upstream QA compatibility export was restored at `836f37cce` before the final gate and live run.

## What was tested

- Deterministic RED covered the absent scoped lane, SKIP falsely certifying, the broad observation remaining truncated, post-open directory replacement, stale/external descriptor traversal, root-open ENOENT/ENOTDIR races, and locale-sensitive non-ASCII ordering (`red-first.txt`).
- Seven focused suites on the final source head passed: 66 tests, 260 assertions, including the newly merged x-search consumer of the existing driver exports (`focused-seven-suites-66-tests.log`).
- The driver self-test, package typecheck, exact changed-file Biome check, no-excuse audit, and changed-file LSP diagnostics passed.
- The authoritative post-merge `bun run test:senpi` passed with 2,670 tests, 7 platform skips, 0 failures, followed by the evidence resolver's 10 passing tests (`full-test-senpi-summary.txt`).
- The installed real Senpi binary ran `drive.mjs` from the exact final source head (`real-driver-command.txt`, `real-driver.jsonl`).

## What was observed

The real driver returned operational `result:"PASS"`, with ultrawork injection and comment-checker behavior both passing. The independent controlled lane returned `isolationCertified:true` because:

- the real QA child emitted an in-process receipt proving exact `HOME`, `USERPROFILE`, `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_CACHE_HOME`, and `SENPI_CODING_AGENT_DIR` routing to the generated sandbox;
- the controlled default Senpi agent root, default OMO agent root, XDG config root, and XDG data root were all observed before and after under the unchanged global limits of 10,000 files, 20,000 entries, and 67,108,864 bytes;
- those observations were complete, untruncated, error-free, and reported exactly zero changed paths.

The original broad real-home lane was not repurposed as proof. It still reports `realHomeIsolationCertified:false`, `realSenpiNonvolatileObservationComplete:false`, and `realSenpiNonvolatileObservationTruncated:true`, with zero observed changed paths. That remains honest fail-closed evidence that a 64 MiB-truncated historical home cannot certify itself.

## Why it is enough

The certification lane proves the child's actual environment rather than inferring isolation from launcher source. Deliberately seeded protected and persistent decoys under both synthetic default agent roots detect fallback from the explicit agent directory; complete XDG config/data observations detect persistent writes through those environment lanes. Operational success is required for certification, so a missing binary or absent environment receipt cannot pass.

Traversal is bound to a no-follow directory descriptor, checks descriptor identity/type against the initial metadata before enumeration, uses descriptor-relative children, and rechecks descriptor plus logical-path identity after traversal. Runtimes without a portable descriptor path fail closed as `DIRECTORY_IDENTITY_UNAVAILABLE`. Root disappearance after the initial lstat is a replacement, never complete absence. Canonical paths and errors use locale-independent code-point ordering after separator normalization. Existing volatile filtering, directory markers, protected-symlink rejection, observation-domain validation, and primary-error precedence remain covered.

## Scope and omissions

`origin/dev` at `cda52da52ff841be64823f23ba95139c0cd71fcd` is merged. Relative to that base, scope checks show zero changes in `script/**`, `scripts/**`, native packages/manifests, package manifests, lock/pins/patches, OAuth, CI, generated bundles, and unrelated source (`repository-integrity.txt`).

The prior `c42f893c9` run is retained as historical fail-closed broad-scan proof but is explicitly superseded as acceptance evidence. Raw credential values, protected hashes, auth headers, model transcripts, environment dumps, user-specific absolute paths, and random sandbox names are omitted. The live payload is sanitized while retaining all deciding machine fields.

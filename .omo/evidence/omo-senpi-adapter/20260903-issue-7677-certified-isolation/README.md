# Issue #7677 bounded live isolation certification

Canonical acceptance evidence for source head `a0aff6422546ac1267b88dd1b0ff8144421e5483`, with refreshed evidence committed separately. The source head includes merged `origin/dev` at `05a1fbcc7` and the isolation race remediation commit `a0aff6422`. Evidence files are tracked and committed; no ignored evidence path was force-added.

## What was tested

- Deterministic RED then GREEN covered raw directory-descriptor close failure, persistent regular files named `sessions`, `cache`, or `logs`, replacement symlink non-dereference, primary-error precedence, descriptor identity, root races, bounded traversal, and certification semantics (`red-first.txt`, focused suite log).
- Seven focused isolation/task-13/upstream-compatibility suites passed: 69 tests, 267 assertions.
- Driver self-test, package typecheck, exact changed-file Biome, no-excuse audit, and changed-file LSP diagnostics passed.
- The authoritative `bun run test:senpi` passed with 2680 tests passing, 7 platform skips, 0 failures, followed by the evidence resolver's 10 passing tests (`full-test-senpi-summary.txt`).
- The installed real Senpi binary ran `drive.mjs` from source head `a0aff6422546ac1267b88dd1b0ff8144421e5483` (`real-driver-command.txt`, `real-driver.jsonl`).

## What was observed

The real driver returned operational `result:PASS`, with `isolationCertified:true`, while retaining honest broad-home semantics: `realHomeIsolationCertified:false`, `realSenpiNonvolatileObservationComplete:false`, and `realSenpiNonvolatileObservationTruncated:true`. The controlled lane was complete, untruncated, error-free, and reported zero changed paths across the default Senpi/OMO agent roots and XDG config/data roots. The real Senpi home remained fail-closed because its broad observation exceeded the 64 MiB limit; this was not repurposed as certification.

The implementation now observes entry type before applying volatility filtering, hashes regular files through `O_RDONLY|O_NOFOLLOW`, fails closed when no-follow support is unavailable, and surfaces raw directory-descriptor close errors when traversal has no primary failure. Existing directory-handle close behavior and primary-error precedence remain covered.

## Scope and omissions

`origin/dev` at `05a1fbcc7` was fetched and merged before the source fix. Restricted-scope checks prove zero changes in script/script directories, native/manifests, locks/pins/patches, OAuth, CI, generated bundles, and unrelated source relative to the merged base (`repository-integrity.txt`). Raw credentials, auth headers, transcripts, environment dumps, absolute user paths, and temporary sandbox names are sanitized or omitted.

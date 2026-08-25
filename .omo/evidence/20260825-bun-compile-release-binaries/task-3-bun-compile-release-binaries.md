# Task 3 - darwin-arm64 bare binary live-drive evidence

## WHAT WAS TESTED

Fresh rerun on 2026-08-25 against the current 22:36 rebuilt binary:

- Binary: `/tmp/work-binary-assets/.omo/release-binaries/omo-darwin-arm64`
- File mtime observed: `2026-08-25 22:36:51`
- Size: `111765538` bytes
- Build-reported embedded sidecars: `1158`
- Fresh isolated QA root: `/tmp/omo-task3-current.Warjaw`
- Fresh HOME, XDG_CONFIG_HOME, XDG_DATA_HOME, XDG_STATE_HOME, XDG_CACHE_HOME, and OMO_CODING_AGENT_DIR were used.

The stale-binary results from the prior run are discarded. The current binary has the byte-preserving fix: provisioning succeeds and materializes the expected runtime tree. This run captures the new `--version`/re-exec defect reported by the user.

## OBSERVED OUTPUT

First-run and second-run wrapper invocations were captured separately:

```text
first run:  exit=1, stdout bytes=0, stderr bytes=0
second run: exit=1, stdout bytes=0, stderr bytes=0
```

Both stdout and stderr files were empty. Provisioning nevertheless succeeded before the wrapper failure. The isolated runtime contained:

```text
.provisioned
assets/clankolas.png
CHANGELOG.md
docs/
examples/
export-html/
native/
node_modules/
omo
package.json
photon_rs_bg.wasm
plugin/
theme/
```

The provisioned executable was a valid arm64 Mach-O with mode 755 and the same 111765538-byte size.

Invoking that provisioned executable directly (not through the downloaded wrapper) produced the exact stamped line:

```text
omo 0.0.0-0.plan (engine: senpi 2026.8.24)
```

Exact bytes were 43 bytes including the trailing newline, with exit 0 and empty stderr. Thus the exact version string exists in the provisioned path, but the required first-run and second-run wrapper behavior is broken.

## SCENARIO RESULTS

| Scenario | Result | Observable |
| --- | --- | --- |
| (a) first-run self-provisioning, exact stamped version, second-run consistency | **BLOCKED** | Provisioning PASS: `.provisioned`, `omo`, package manifest, assets, docs, examples, export-html, native, node_modules and plugin materialized. Acceptance fails because both wrapper runs exit 1 with empty stdout/stderr. Direct provisioned executable returns the exact stamped line with exit 0. |
| (b) doctor/setup report + engine pin | **BLOCKED** | Downloaded wrapper `doctor`: exit 1, stdout 0 bytes, stderr 0 bytes. Direct provisioned `doctor`: exit 1, stdout/stderr 0 bytes. No engine pin report. |
| (c) plugin-loaded marker | **BLOCKED** | Downloaded wrapper `--print hello`: exit 1 silently. Direct provisioned `--print hello` was killed with exit 137 and no output; no reliable plugin marker was produced. |
| (d) provisioned-path PTY round-trip, native not pipe fallback | **BLOCKED** | Downloaded wrapper PTY `--version`: exit 1 silently. Direct provisioned PTY `--version`: exit 1 with zero stdout/stderr. No native-vs-pipe observable was produced. |
| (e) real `~/.omo` / `~/.senpi` untouched proof | **BLOCKED** | All binary execution used fresh isolated directories, but the real-home newer-file receipt contained concurrent activity under `/Users/yeongyu/.omo/agent`; a clean untouched PASS cannot be claimed. No `.senpi` paths appeared. |
| (f) copied provisioned dir without sibling `package.json` | **BLOCKED** | Copying the completed provisioned directory and removing `package.json` produced exit 1 with zero stdout/stderr. The expected silent `0.0.0` mis-stamp was not reached because the executable fails silently earlier. |

No scenario receives PASS under the requested acceptance criteria. The provisioning substep and direct provisioned-path version line are PASS observables; the end-to-end scenarios remain BLOCKED by the silent launcher/re-exec failure.

## WHY THIS IS ENOUGH

This is a fresh execution of the current 22:36 binary, with every user-state location redirected to fresh temporary directories. It verifies the byte-preserving fix by confirming the PNG and complete sidecar tree materialize without integrity errors. It also captures the requested first/second `--version` statuses and byte counts exactly, plus a direct provisioned-path control showing the stamped version line itself is available.

The remaining defect is deterministic: the downloaded wrapper provisions successfully, then its child/re-exec path exits 1 without output. The same silent failure prevents doctor, plugin, and PTY acceptance, and masks the intended missing-package `0.0.0` negative control. No implementation was edited in this task.

## CLEANUP RECEIPTS

Fresh isolated QA root:

```text
/tmp/omo-task3-current.Warjaw
```

Fresh real-home receipt:

```text
/tmp/omo-task3-current-real.XkU26o
```

Cleanup performed after evidence transcription:

```sh
rm -rf /tmp/omo-task3-current.Warjaw /tmp/omo-task3-current-real.XkU26o \
  /tmp/omo-task3-current-root /tmp/omo-task3-current-receipt
```

The builder's temporary staging, plugin-stage, and embed-probe directories were cleaned by their `finally` paths. The requested binary under `.omo/release-binaries` was left untouched. No quarantine attributes were stripped and no real agent directory was used as an execution target.

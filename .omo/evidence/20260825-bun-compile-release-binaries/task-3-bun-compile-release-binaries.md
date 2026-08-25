# Task 3 - darwin-arm64 bare binary live-drive evidence

## WHAT WAS TESTED

Fresh rerun on 2026-08-25 against the requested rebuilt binary:

- Binary: `/tmp/work-binary-assets/.omo/release-binaries/omo-darwin-arm64`
- Size: 111765538 bytes
- Build-reported embedded sidecars: 1158
- Fresh isolated QA root: `/tmp/omo-task3-final.unM5Za`
- Fresh HOME, XDG_CONFIG_HOME, XDG_DATA_HOME, XDG_STATE_HOME, XDG_CACHE_HOME, and OMO_CODING_AGENT_DIR were used for every invocation.

The two prior BLOCKED runs drove the two fixes now present:

1. `58065b777` selected the exact top-level `omo-runtime/runtime-manifest.json`, avoiding the unrelated Senpi manifest.
2. `09347ec2f` normalized embedded asset paths by stripping the `omo-runtime/` prefix.

This run confirms both prior blockers are past: the binary selects the intended manifest and finds `CHANGELOG.md`. It reaches the next provisioning failure on binary asset integrity.

Commands driven against a copied real executable:

```sh
omo-darwin-arm64 --version                 # twice
omo-darwin-arm64 doctor
omo-darwin-arm64 --print hello
python3 packages/omo-native/test/tty-driver.py '' '' omo-darwin-arm64 --version
```

## OBSERVED OUTPUT

The first and second `--version` runs both exited 1 with empty stdout. Exact error:

```text
error: embedded asset integrity mismatch: assets/clankolas.png
      at provisionEmbeddedRuntime (/$bunfs/root/omo-darwin-arm64:706068:13)
      at async main2 (/$bunfs/root/omo-darwin-arm64:706141:35)

Bun v1.4.0-canary.1+b58cd4685 (macOS arm64)
```

Provisioning did begin and materialized initial text assets, including `CHANGELOG.md` and `README.md`, before reaching the PNG. The failure is caused by the provisioner reading every embedded asset through text conversion before hashing/writing it; the manifest contains binary PNG bytes.

All four live entry points produced the same integrity failure:

- `--version` first run: exit 1
- `--version` second run: exit 1
- `doctor`: exit 1
- `--print hello`: exit 1
- PTY `--version`: exit 1, with the same error plus PTY ANSI formatting

## SCENARIO RESULTS

| Scenario | Result | Observable |
| --- | --- | --- |
| (a) first-run self-provisioning, exact stamped version, second-run consistency | **BLOCKED** | Both runs exit 1; no stamped version line, `.provisioned` marker, or provisioned `omo` executable is produced. |
| (b) doctor/setup report + engine pin | **BLOCKED** | `doctor` exits 1 during provisioning with `embedded asset integrity mismatch: assets/clankolas.png`; no engine pin report. |
| (c) plugin-loaded marker | **BLOCKED** | `--print hello` exits 1 before engine/plugin startup with the same integrity error. |
| (d) provisioned-path PTY round-trip, native not pipe fallback | **BLOCKED** | PTY driver exits 1 during provisioning; there is no completed provisioned path from which to load the native prebuild, so pipe-vs-native cannot be asserted. |
| (e) real `~/.omo` / `~/.senpi` untouched proof | **BLOCKED** | The binary itself used only fresh isolated directories, but the real-home newer-file receipt contained concurrent activity under `/Users/yeongyu/.omo/agent`; therefore a clean untouched PASS cannot honestly be claimed. No `.senpi` paths appeared in the receipt. |
| (f) copied provisioned dir without sibling `package.json` | **BLOCKED** | No valid provisioned executable was produced. The attempted copied directory had no `omo` binary, so the intended silent `0.0.0` negative control was unreachable. |

No PASS is claimed: the binary reaches the next real provisioning defect but does not complete scenario (a), which is prerequisite for the provisioned-path scenarios and the negative control.

## WHY THIS IS ENOUGH

This is a fresh execution of the real rebuilt darwin-arm64 bare executable at the requested path, not a source-level substitute. The two earlier defects are demonstrably fixed: the wrong-manifest error is gone, and the `CHANGELOG.md` missing-asset error is gone. The deterministic next failure is emitted by the compiled provisioner while processing the first binary PNG and is reproduced across both version runs, doctor, plugin probe, and PTY invocation.

The exact failing asset identifies the required follow-up: use byte-preserving access (`arrayBuffer()`/bytes) for embedded assets, rather than converting binary assets through `text()` before integrity verification and materialization.

The task write scope permits only task-3 evidence and scratch, so implementation was not edited here.

## CLEANUP RECEIPTS

Fresh QA root and real-home receipt used:

```text
/tmp/omo-task3-final.unM5Za
/tmp/omo-task3-final-real.XXXXXX
```

The actual receipt path was recorded in scratch before cleanup. Cleanup performed after transcription:

```sh
rm -rf /tmp/omo-task3-final.unM5Za /tmp/omo-task3-final-real.* /tmp/omo-task3-final-root /tmp/omo-task3-final-receipt
```

The builder's own temporary staging, plugin-stage, and embed-probe directories were cleaned by its `finally` paths. The requested binary under `.omo/release-binaries` was left untouched. No quarantine attributes were stripped and no real agent directory was used as an execution target.

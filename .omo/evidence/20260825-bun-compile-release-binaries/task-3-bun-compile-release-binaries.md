# Task 3 - darwin-arm64 bare binary live-drive evidence

## WHAT WAS TESTED

Fresh rerun on 2026-08-25 against the rebuilt binary:

- Binary: `/tmp/work-binary-assets/dist/release-binaries/omo-darwin-arm64`
- Size: 111765538 bytes
- Build-reported embedded sidecars: 1158
- Fresh isolated root: `/tmp/omo-task3-e2e.kk5nAF`
- Fresh HOME/XDG/agent dirs were used for every invocation.

The earlier BLOCKED run (manifest selection) led to commit `58065b777`, which selects the exact top-level `omo-runtime/runtime-manifest.json`. This rerun confirms that blocker is fixed and reaches provisioning.

Commands driven against the copied real binary:

```sh
omo-darwin-arm64 --version                 # twice
omo-darwin-arm64 doctor
omo-darwin-arm64 --print hello
python3 packages/omo-native/test/tty-driver.py '' '' omo-darwin-arm64 --version
```

## OBSERVED OUTPUT (RED before / current rebuilt binary)

The first and second `--version` runs both exited 1 with empty stdout. Exact error:

```text
error: embedded asset missing: CHANGELOG.md
      at provisionEmbeddedRuntime (/$bunfs/root/omo-darwin-arm64:706061:13)
      at main2 (/$bunfs/root/omo-darwin-arm64:706138:35)

Bun v1.4.0-canary.1+b58cd4685 (macOS arm64)
```

The same error occurred for `doctor`, the scripted plugin probe, and the PTY driver. The failing source path is the provisioner lookup:

```ts
const byPath = new Map(embedded.map((file) => [file.name.replace(/^\.\//, ""), file]))
const file = byPath.get(entry.relPath.replace(/^\.\//, ""))
```

The manifest entry is `CHANGELOG.md`, while the compile asset namespace retains the `omo-runtime/` prefix. Provisioning therefore fails before it can write the executable or any sidecar.

## SCENARIO RESULTS

| Scenario | Result | Observable |
| --- | --- | --- |
| (a) first-run self-provisioning, exact stamped version, second-run consistency | **BLOCKED** | Both runs exit 1; no version line; no provisioned `omo` or manifest materialization. |
| (b) doctor/setup report + engine pin | **BLOCKED** | `doctor` exits 1 with the same `embedded asset missing: CHANGELOG.md` error. |
| (c) plugin-loaded marker | **BLOCKED** | `--print hello` exits 1 during provisioning, before engine/plugin startup. |
| (d) provisioned-path PTY round-trip, native not pipe fallback | **BLOCKED** | PTY driver exits 1 with the same provisioning error; no provisioned path exists from which to load native PTY. |
| (e) real `~/.omo` / `~/.senpi` untouched proof | **BLOCKED** | Controlled invocations used isolated HOME, but the real-home receipt had concurrent newer activity under `/Users/yeongyu/.omo/agent`; a clean untouched PASS cannot be asserted from this run. No `.senpi` changes were observed. |
| (f) copied provisioned dir without sibling `package.json` | **BLOCKED** | No valid provisioned directory was produced. The attempted copy had no `omo` executable, so the intended silent `0.0.0` control was unreachable. |

No PASS is claimed: the rebuilt binary reaches the next provisioning defect, but does not complete scenario (a), which is prerequisite for (b)-(d) and (f).

## WHY THIS IS ENOUGH

This is a fresh execution of the real rebuilt darwin-arm64 bare executable, not a source substitute. The manifest-selection fix is demonstrably active because the prior unrelated-manifest failure disappeared. The deterministic next failure is emitted by the real compiled provisioner and is identical across the first-run, second-run, doctor, plugin, and PTY paths. The exact manifest entry and lookup mismatch identify the required follow-up fix: normalize embedded names by removing the known `omo-runtime/` payload prefix (or construct the lookup key with that prefix) before provisioning.

The task write scope permits only task-3 evidence and scratch, so implementation was not edited here.

## CLEANUP RECEIPTS

Temporary root and receipt were removed after transcription:

```sh
rm -rf /tmp/omo-task3-e2e.kk5nAF /tmp/omo-task3-real-receipt.dYhays /tmp/omo-task3-current-root /tmp/omo-task3-real-receipt
```

Build outputs under `dist/release-binaries` were left untouched. No quarantine attributes were stripped and no real agent directory was used as an execution target.

# Task 3 - darwin-arm64 bare binary live-drive evidence

## WHAT WAS TESTED

Fresh six-scenario rerun on 2026-08-25 against the requested binary:

- Binary: `/tmp/work-binary-assets/.omo/release-binaries/omo-darwin-arm64`
- Size: 111765538 bytes
- Build-reported embedded sidecars: 1158
- Fresh isolated QA root: `/tmp/omo-task3-pass.PoZaUn`
- Fresh HOME, XDG_CONFIG_HOME, XDG_DATA_HOME, XDG_STATE_HOME, XDG_CACHE_HOME, and OMO_CODING_AGENT_DIR were used.

The three prior BLOCKED runs drove three fixes:

1. `58065b777` selected the exact top-level `omo-runtime/runtime-manifest.json`.
2. `09347ec2f` normalized embedded asset paths by stripping `omo-runtime/`.
3. `ab509291a` preserved binary embedded assets using bytes/raw arrayBuffer access.

This run was against the stated rebuilt binary, but its compiled runtime still executes the pre-fix text conversion path. The source worktree contains the third fix, while the supplied binary's runtime stack still shows `embeddedText` at the provisioning call site.

## OBSERVED OUTPUT

Both first-run and second-run `--version` invocations exited 1 with empty stdout:

```text
706066 |     const content = await embeddedText(file);
706067 |     const bytes = embeddedBytes(file, content);
706068 |       throw new Error(`embedded asset integrity mismatch: ${entry.relPath}`);
                     ^
error: embedded asset integrity mismatch: assets/clankolas.png
      at provisionEmbeddedRuntime (/$bunfs/root/omo-darwin-arm64:706068:13)
      at async main2 (/$bunfs/root/omo-darwin-arm64:706141:35)

Bun v1.4.0-canary.1+b58cd4685 (macOS arm64)
```

The binary selected the intended manifest and found normalized text assets; it materialized `CHANGELOG.md` and `README.md` before failing on the PNG. The same integrity error occurred for `doctor`, `--print hello`, and the PTY invocation.

## SCENARIO RESULTS

| Scenario | Result | Observable |
| --- | --- | --- |
| (a) first-run self-provisioning, exact stamped version, second-run consistency | **BLOCKED** | Both runs exit 1; no exact stamped version line, `.provisioned` marker, or provisioned `omo` executable. |
| (b) doctor/setup report + engine pin | **BLOCKED** | `doctor` exits 1 during provisioning on `assets/clankolas.png`; no engine pin report. |
| (c) plugin-loaded marker | **BLOCKED** | `--print hello` exits 1 before engine/plugin startup. |
| (d) provisioned-path PTY round-trip, native not pipe fallback | **BLOCKED** | PTY driver exits 1 during provisioning; no completed provisioned path exists for native PTY verification. |
| (e) real `~/.omo` / `~/.senpi` untouched proof | **BLOCKED** | The binary used only fresh isolated directories, but the real-home newer-file receipt contained concurrent activity under `/Users/yeongyu/.omo/agent`; therefore a clean untouched PASS cannot honestly be claimed. No `.senpi` paths appeared. |
| (f) copied provisioned dir without sibling `package.json` | **BLOCKED** | No provisioned executable was produced; the copied partial directory had no `omo`, so the intended silent `0.0.0` control was unreachable. |

No PASS is claimed. The exact requested binary is not behaviorally consistent with the claimed third fix, so the six acceptance scenarios cannot complete.

## WHY THIS IS ENOUGH

This is a fresh execution of the real bare darwin-arm64 executable at the requested path, with all state redirected to fresh temporary directories. The prior wrong-manifest and missing-asset-path failures are past. The remaining failure is deterministic and visible in the compiled binary's own stack: it still calls `embeddedText(file)` before `embeddedBytes`, which corrupts binary assets. Rebuilding the binary from the byte-preserving source, then rerunning this matrix, is required for PASS.

## CLEANUP RECEIPTS

Actual paths used:

```text
/tmp/omo-task3-pass.PoZaUn
/tmp/omo-task3-pass-real.XkU26o
```

Cleanup command after transcription:

```sh
rm -rf /tmp/omo-task3-pass.PoZaUn /tmp/omo-task3-pass-real.XkU26o /tmp/omo-task3-pass-root /tmp/omo-task3-pass-receipt /tmp/omo-task3-pass-paths
```

The requested binary under `.omo/release-binaries` was not modified. No quarantine attributes were stripped and no real agent directory was used as an execution target.

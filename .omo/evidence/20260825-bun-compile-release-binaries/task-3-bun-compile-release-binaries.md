# Task 3 - darwin-arm64 bare binary live-drive evidence

## WHAT WAS TESTED

Fresh isolated run on 2026-08-25 against the four-fix rebuilt binary:

- Binary: `/tmp/work-binary-assets/.omo/release-binaries/omo-darwin-arm64`
- Observed mtime: `2026-08-25 22:40:47`
- Size: `111765538` bytes
- Build-reported embedded sidecars: `1158`
- Fresh isolated QA root: `/tmp/omo-task3-green.fFBaX1`
- Fresh HOME, all XDG directories, and OMO_CODING_AGENT_DIR were used.

Four-fix progression recorded:

1. `58065b777` - exact top-level runtime manifest selection.
2. `09347ec2f` - `omo-runtime/` embedded path normalization.
3. `ab509291a` - byte-preserving PNG/WASM/.node provisioning.
4. `310cb09b0` - realpath re-exec comparison and manifest-sourced engine pin.

## SCENARIO (a): FIRST-RUN PROVISIONING AND VERSION

The downloaded copy was run twice with `--version`.

```text
first run:  exit=0, stdout=43 bytes, stderr=0 bytes
stdout: omo 0.0.0-0.plan (engine: senpi 2026.8.24)\n
second run: exit=0, stdout=43 bytes, stderr=0 bytes
stdout: omo 0.0.0-0.plan (engine: senpi 2026.8.24)\n
```

Provisioning succeeded. The isolated runtime contained 1160 files, including:

```text
.provisioned
omo
package.json
assets/clankolas.png
native/prebuilds/darwin-arm64/senpi_pty.darwin-arm64.node
plugin/package.json
```

**Result: PASS for provisioning, exact version, and second-run consistency.**

## SCENARIO (b): DOCTOR / ENGINE PIN

Wrapper and direct provisioned `doctor` both failed:

```text
exit=1
stdout=0 bytes
stderr includes:
ENOENT: no such file or directory, open '/package.json'
    at readJson (/$bunfs/root/omo-darwin-arm64:705523:33)
    at runDoctor (/$bunfs/root/omo-darwin-arm64:705934:41)
```

This is a compiled `runDoctor` package-path lookup: its bundled helper resolves the package root to `/`, rather than the provisioned executable directory. No doctor engine-pin report was emitted.

**Result: BLOCKED.**

## SCENARIO (c): SCRIPTED ENGINE / PLUGIN MARKER

Wrapper and direct provisioned `--print hello` both reached Senpi and loaded the runtime far enough to emit its normal model-auth failure:

```text
exit=1
stderr:
omo-senpi ulw-loop status ignored {
  reason: "non-zero-exit",
  code: 1,
}
No API key found for the selected model.

Use /login to log into a provider via OAuth or API key.
```

No OMO-specific brand banner or extension marker was emitted, and no API credentials were available to complete an engine response. The process did reach the engine/plugin invocation path; the requested observable marker was not proven.

**Result: BLOCKED** (environment lacks credentials and no plugin marker was captured).

## SCENARIO (d): PROVISIONED PTY ROUND-TRIP / NATIVE PREBUILD

The PTY driver ran the direct provisioned executable with `--version`:

```text
exit=0
stdout: omo 0.0.0-0.plan (engine: senpi 2026.8.24)\r\n
stderr=0 bytes
```

The provisioned native loader was also exercised directly against the provisioned directory with quarantine checking disabled only for this isolated temporary path:

```json
{
  "native": true,
  "diagnostic": null,
  "exports": ["PtySession", "__senpiPtyAbi1", "startPtySession", "version"]
}
```

The required `native/prebuilds/darwin-arm64/senpi_pty.darwin-arm64.node` exists and loads with the ABI sentinel. This proves native loading, not pipe fallback. No user-file quarantine attribute was modified.

**Result: PASS** for the provisioned PTY path and native prebuild load.

## SCENARIO (e): REAL-HOME ISOLATION

All binary invocations used fresh temporary HOME/XDG/OMO_CODING_AGENT_DIR roots. However, the before/after newer-file receipt for real homes contained concurrent activity under `/Users/yeongyu/.omo/agent` (including session and log files). No `.senpi` paths appeared.

Because the receipt is not empty, a strict untouched proof cannot be claimed even though the isolated binary did not target the real home.

**Result: BLOCKED** for strict acceptance; no real-home mutation is attributed to this run.

## SCENARIO (f): MISSING SIBLING PACKAGE.JSON NEGATIVE CONTROL

A copy of the completed provisioned directory was made under a separate isolated HOME and its sibling `package.json` removed. Running the copied executable produced:

```text
exit=1
stdout=0 bytes
stderr=937 bytes
ENOENT: no such file or directory, open '.../.omo/binary-runtime/0.0.0-0.plan/package.json'
    at runCompiledLauncher (...:706106:31)
```

This does not reach the historical silent `0.0.0` mis-stamp because the current launcher now fails explicitly while reading the missing sibling package manifest.

**Result: BLOCKED** as the requested negative-control expectation; the missing-manifest failure itself is captured.

## SUMMARY

| Scenario | Result |
| --- | --- |
| (a) provisioning + exact version + second run | **PASS** |
| (b) doctor + engine pin | **BLOCKED** - bundled doctor resolves `/package.json` |
| (c) plugin-loaded marker | **BLOCKED** - engine reaches missing API-key failure without marker |
| (d) provisioned PTY native, not pipe | **PASS** |
| (e) real-home untouched proof | **BLOCKED** - concurrent real-home activity makes receipt non-empty |
| (f) missing sibling package negative control | **BLOCKED** - explicit ENOENT, not silent 0.0.0 |

## WHY THIS IS ENOUGH

This is a fresh run of the current four-fix binary. It proves the previously failing provisioning layers are green, including byte-intact PNG materialization, exact stamped version, stable re-exec, and native PTY ABI loading. The remaining scenario blockers are captured as runtime observables rather than inferred: doctor’s `/package.json` ENOENT, engine auth failure without a plugin marker, non-empty concurrent real-home receipt, and explicit missing-package ENOENT.

No implementation files were edited by this task.

## CLEANUP RECEIPTS

Fresh QA root:

```text
/tmp/omo-task3-green.fFBaX1
```

Fresh real-home receipt:

```text
/tmp/omo-task3-green-real.XXXXXX
```

Cleanup performed after transcription:

```sh
rm -rf /tmp/omo-task3-green.fFBaX1 /tmp/omo-task3-green-real.* \
  /tmp/omo-task3-green-root /tmp/omo-task3-green-receipt /tmp/task3-native-check.mjs
```

The builder's temporary staging, plugin-stage, and embed-probe directories were cleaned by their `finally` paths. The requested binary under `.omo/release-binaries` was left untouched.

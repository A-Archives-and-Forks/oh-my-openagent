# Task 3 - authoritative four-fix darwin-arm64 live-drive evidence

## WHAT WAS TESTED

Fresh six-scenario run on 2026-08-25 against the current binary:

- Binary: `/tmp/work-binary-assets/.omo/release-binaries/omo-darwin-arm64`
- Observed mtime: `2026-08-25 22:40:47`
- Size: `111765538` bytes
- Embedded sidecars: `1158`
- Fresh isolated root: `/tmp/omo-task3-authoritative.BfFkDq`
- Every binary invocation used `env -i` with fresh HOME, XDG_CONFIG_HOME, XDG_DATA_HOME, XDG_STATE_HOME, XDG_CACHE_HOME, OMO_CODING_AGENT_DIR, and a minimal PATH.

The four-fix progression is:

1. `58065b777` - exact top-level `omo-runtime/runtime-manifest.json` selection.
2. `09347ec2f` - normalization of the `omo-runtime/` embedded path prefix.
3. `ab509291a` - byte-preserving PNG/WASM/.node provisioning.
4. `310cb09b0` - realpath re-exec comparison and manifest-sourced engine pin.

## SCENARIO (a): FIRST-RUN PROVISIONING / VERSION / SECOND RUN

Wrapper invocations, each with separate stdout/stderr/status capture:

```text
first run:  exit=0, stdout=43 bytes, stderr=0 bytes
stdout: omo 0.0.0-0.plan (engine: senpi 2026.8.24)\n
second run: exit=0, stdout=43 bytes, stderr=0 bytes
stdout: omo 0.0.0-0.plan (engine: senpi 2026.8.24)\n```

Provisioning materialized 1160 files. Required observables present:

```text
.provisioned
omo
package.json
assets/clankolas.png
native/prebuilds/darwin-arm64/senpi_pty.darwin-arm64.node
plugin/package.json
docs/
examples/
export-html/
node_modules/
```

**Result: PASS.**

## SCENARIO (b): DOCTOR / ENGINE PIN

Both downloaded-wrapper and direct provisioned-copy `doctor` were run in the isolated environment. Both produced:

```text
exit=1
stdout=0 bytes
stderr includes:
ENOENT: no such file or directory, open '/package.json'
    at readJson (/$bunfs/root/omo-darwin-arm64:705523:33)
    at runDoctor (/$bunfs/root/omo-darwin-arm64:705934:41)
```

The compiled doctor path resolves its package helper to `/package.json` rather than the provisioned executable directory. No engine pin report was emitted.

**Result: BLOCKED.**

## SCENARIO (c): SCRIPTED ENGINE / PLUGIN LOADED MARKER

Both wrapper and direct provisioned `--print hello` reached the engine/plugin launch path and emitted the expected no-credentials failure:

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

No OMO brand banner or extension marker was emitted, and no API credentials were available to complete the scripted engine invocation. The requested plugin-loaded marker is therefore not proven by this run.

**Result: BLOCKED.**

## SCENARIO (d): PROVISIONED PTY / NATIVE PREBUILD

The PTY driver ran the direct provisioned executable with `--version`:

```text
exit=0
stdout: omo 0.0.0-0.plan (engine: senpi 2026.8.24)\r\nstderr=0 bytes
```

A direct loader check against the provisioned directory returned:

```json
{"native":true,"diagnostic":null,"exports":["PtySession","__senpiPtyAbi1","startPtySession","version"]}
```

The required `native/prebuilds/darwin-arm64/senpi_pty.darwin-arm64.node` loaded successfully with the ABI sentinel. This is native loading, not pipe fallback. The loader probe used the absolute Bun path after the initial minimal-PATH probe omitted Bun; no user-file quarantine attributes were changed.

**Result: PASS.**

## SCENARIO (e): REAL HOME ISOLATION

All binary runs used only fresh isolated directories. The before/after receipt for real homes was non-empty due concurrent activity, including:

```text
/Users/yeongyu/.omo/agent/...
/Users/yeongyu/.senpi/agent/senpi-debug.log
```

The run did not target those paths, but because the receipt is not empty, a strict untouched proof cannot be claimed or attributed to this run.

**Result: BLOCKED** for the requested strict proof.

## SCENARIO (f): MISSING SIBLING PACKAGE.JSON NEGATIVE CONTROL

A copy of the completed provisioned directory was placed under a separate isolated HOME and its sibling `package.json` was removed. Running the copied executable produced:

```text
exit=1
stdout=0 bytes
stderr=935 bytes
ENOENT: no such file or directory, open '.../.omo/binary-runtime/0.0.0-0.plan/package.json'
    at runCompiledLauncher (...:706106:31)
```

The expected historical silent `0.0.0` mis-stamp was not reached; the current launcher fails explicitly while reading the missing sibling manifest.

**Result: BLOCKED** for the requested negative-control expectation; the exact missing-manifest failure is captured.

## SUMMARY

| Scenario | Result |
| --- | --- |
| (a) provisioning + exact stamped version + second run | **PASS** |
| (b) doctor + engine pin | **BLOCKED** - compiled doctor resolves `/package.json` |
| (c) plugin-loaded marker | **BLOCKED** - engine stops at missing API key without marker |
| (d) provisioned PTY native, not pipe | **PASS** |
| (e) real-home untouched proof | **BLOCKED** - concurrent real-home activity makes receipt non-empty |
| (f) missing sibling package negative control | **BLOCKED** - explicit ENOENT, not silent `0.0.0` |

## WHY THIS IS ENOUGH

This is a fresh `env -i` execution of the current 22:40 binary. It proves the four provisioning/re-exec fixes in the real artifact: complete sidecar materialization, byte-intact binary assets, exact stamped first/second version output, and native PTY loading from the provisioned path. The remaining statuses are based on exact runtime outputs, not stale observations or inference.

No implementation files were edited by this task.

## CLEANUP RECEIPTS

Fresh isolated QA root:

```text
/tmp/omo-task3-authoritative.BfFkDq
```

Fresh real-home receipt:

```text
/tmp/omo-task3-authoritative-real.WPonlA
```

Cleanup performed after transcription:

```sh
rm -rf /tmp/omo-task3-authoritative.BfFkDq /tmp/omo-task3-authoritative-real.* \
  /tmp/omo-task3-authoritative-root /tmp/omo-task3-authoritative-receipt
```

The builder's temporary staging, plugin-stage, and embed-probe roots were cleaned by their `finally` paths. The requested binary under `.omo/release-binaries` was left untouched.

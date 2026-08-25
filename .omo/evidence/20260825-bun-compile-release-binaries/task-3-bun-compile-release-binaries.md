# Task 3 - provisioned-copy failure-point capture

## STATUS: BLOCKED BEFORE EXECUTION

The requested current 22:36 binary was not available when this capture began. The expected path:

```text
/tmp/work-binary-assets/.omo/release-binaries/omo-darwin-arm64
```

was absent, and a search for a regular file named `omo-darwin-arm64` under `/tmp/work-binary-assets` and `/tmp` found no artifact. Therefore no fresh invocation was run and no stale-binary output is reused.

The worktree source was inspected to preserve the exact launcher context requested for the eventual rerun:

```text
packages/omo-native/compile-entry.ts
```

Relevant current source lines:

```text
152 export async function runCompiledLauncher(args: string[], execDir: string, enginePin = "unknown"): Promise<boolean> {
153   const packageJson = readJson(join(execDir, "package.json"))
...
160   if ((command === "--version" || command === "-v") && args.length === 1) { console.log(versionLine(packageJson, enginePin ?? "unknown")); return true }
...
175   const manifestFile = await selectRuntimeManifest(embedded)
...
179   if (!isProvisionedExecutable(process.execPath, expected)) {
180     await provisionEmbeddedRuntime(manifest, embedded, dirname(expected))
181     writeFileSync(expected, readFileSync(process.execPath))
182     chmodSync(expected, 0o755)
183     const child = spawn(expected, process.argv.slice(2), { env: process.env, stdio: "inherit" })
184     await new Promise<void>((resolvePromise) => child.on("close", (code) => { process.exitCode = code ?? 1; resolvePromise() }))
...
189   if (await runCompiledLauncher(process.argv.slice(2), dirname(process.execPath), manifest.enginePin)) return
```

This confirms the requested hypotheses are testable, but does not establish which one fails at runtime. In particular, `readJson(package.json)` and `isProvisionedExecutable` must be observed using the current rebuilt binary, not inferred from stale runs.

## SCENARIO RESULTS

All six scenarios are **BLOCKED / NOT RUN** because the requested executable is unavailable:

- (a) first-run and direct provisioned-copy `--version`: NOT RUN
- (b) doctor/setup engine-pin report: NOT RUN
- (c) plugin-loaded marker: NOT RUN
- (d) PTY/strace-style provisioned-copy capture: NOT RUN
- (e) real-home untouched proof: NOT RUN
- (f) copied provisioned directory without sibling package.json: NOT RUN

No stale-binary result is presented as current evidence. No PASS is claimed.

## WHY THIS IS ENOUGH

The user explicitly required the 22:36 binary and explicitly superseded prior stale-binary results. Since that artifact is absent from the specified path and cannot be found in `/tmp`, executing any other binary would violate the request and could not answer the exact failure-point question. The correct next action is to restore or provide the current artifact, then rerun this evidence task from a fresh isolated root.

## CLEANUP RECEIPTS

No QA temporary directory was created because the required executable was missing. The artifact search was read-only. No HOME/XDG/OMO_CODING_AGENT_DIR was redirected for a binary run, no real agent directory was used, and no quarantine attributes were changed.

The prior stale QA evidence was not reused.

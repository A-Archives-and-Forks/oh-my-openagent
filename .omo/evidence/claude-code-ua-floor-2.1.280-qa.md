# QA: Claude Code UA floor reaches the bundled engine (2.1.280)

Surface: the real `omo` launcher (`node <copy>/bin/omo.js -p --no-session --mode json --provider anthropic --model claude-opus-5-5 "Reply with exactly: OK"`, stdin closed) against an APFS clone of a global `omo-ai@5.0.0-0.beta.84` install (senpi 2026.9.22-4), authenticated with a real Claude subscription OAuth login. Only the three `claudeCodeVersion` declarations in the cloned engine were varied between runs. No credentials, headers or tokens are recorded here.

Declarations: `dist/bundle/chunks/anthropic-messages-*.js`, `dist/bundle/chunks/session-worker.js`, `node_modules/@earendil-works/pi-ai/dist/api/anthropic-messages.js`.

## Case 1 - fresh install (all three at 2.1.251)

exit=0, assistant turns by model=['claude-opus-5-5', 'claude-opus-5-5', 'claude-opus-5'], final text='OK', version_too_old errors=2

The first two assistant turns are `claude-opus-5-5` 400s (`Claude Code 2.1.251 does not support this model; version 2.1.280 or newer is required`, `claude_code_version_too_old`); the retry fallback then answers on `claude-opus-5`.

## Case 2 - floor raised in the pi-ai file only (bundle 2.1.251, pi-ai 2.1.280)

exit=0, assistant turns by model=['claude-opus-5-5', 'claude-opus-5-5', 'claude-opus-5'], final text='OK', version_too_old errors=2

Identical to case 1: the running engine is the pre-linked bundle, so a floor that only rewrites the pi-ai file does not change what is sent.

## Case 3 - fresh install, then this PR's `bin/senpi-patch.mjs` with `OMO_SENPI_PATCH_ROOT=<cloned engine>`

Patch script exit=0; all three declarations read 2.1.280 afterwards.

exit=0, assistant turns by model=['claude-opus-5-5'], final text='OK', version_too_old errors=0

`claude-opus-5-5` answers directly; no version error and no fallback.

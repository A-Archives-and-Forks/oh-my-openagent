# Bun 1.4 compiled-binary receipt

Historical RED checkpoint. The resource and bootstrap failures below were fixed;
the rebuilt binary's passing receipt is `../compiled-consumer-qa.json`, summarized
in `../README.md`.

## What was tested

Using `/tmp/omo-pr8538-tools/node_modules/@oven/bun-darwin-aarch64/bin/bun`
with PATH prefixed by that directory:

```text
bun --version
bun run script/build-omo-binary.ts \
  --target darwin-arm64 \
  --omo-version qa \
  --omo-ai-version qa \
  --out-dir <temporary directory>
<temporary directory>/omo-darwin-arm64 --version
<temporary directory>/omo-darwin-arm64 setup --yes
<temporary directory>/omo-darwin-arm64 migrate --yes
```

Every executable invocation used a temporary HOME, XDG_DATA_HOME,
XDG_CONFIG_HOME, XDG_STATE_HOME, XDG_CACHE_HOME, and all OMO/SENPI/PI
agent-directory variables. The binary and sandbox were deleted afterward.

## What was observed

`bun --version` returned `1.4.0`; the host-target compiled binary build and
`--version` both exited `0`.

The compiled `setup --yes` exited `1` before writing auth. Its stack identifies
`readProviderMap` in `setup-import.js` reading
`new URL("./provider-map.json", import.meta.url)`: that path is absent from the
compiled `$bunfs` filesystem. Compiled `migrate --yes` also exited `1` with no
target settings file.

## Why this is sufficient

This rules out the previous Bun 1.3 toolchain as the cause: the supplied Bun
1.4.0 produces and starts the binary. It isolates the remaining parity failure
to a runtime resource required by an excluded file (`setup-import.js`) or its
build staging, neither of which this lane is authorized to change.

## Omitted

Only a dummy key and temporary fixture files were used. Verbose setup reports,
full minified stack output, binary paths, and all environment values are
omitted.

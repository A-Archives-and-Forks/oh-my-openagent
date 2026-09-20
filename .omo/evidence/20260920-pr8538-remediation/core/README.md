# PR8538 migration-core verification

Historical intermediate checkpoint. The final integrated results and corrections
are recorded in `../README.md`; do not treat the test counts below as the final gate.

Run on 2026-09-20 using Bun 1.4.0:
`/tmp/omo-pr8538-tools/node_modules/@oven/bun-darwin-aarch64/bin/bun`.

## Regression evidence

- Red before implementation:
  `bun test packages/omo-native/test/migrate-regressions.test.ts`
  reported `0 pass, 4 fail`. The failures covered write consent, user config
  selection/recursive merge, safe provider/agent/keybinding translation, and
  unsupported MCP expression handling.
- Green from a clean generated-runtime state:
  `bun test packages/omo-native/test/migrate.test.ts packages/omo-native/test/migrate-regressions.test.ts`
  reported `9 pass, 0 fail, 54 expect() calls`.

The focused suite copies only `packages/omo-native/bin` into a temporary
package and runs the copied launcher with Node-compatible module loading. Its
`beforeAll` invokes `script/build-migration-runtime.ts`; this proves the
ignored runtime is generated before tests rather than retained by the
checkout.

## Packaging and compiled artifact evidence

- `bun run script/build-omo-native.ts` completed with:
  `omo-native payload complete ... (38 required artifacts present)`.
- `bun run script/build-omo-binary.ts --target darwin-arm64
  --omo-version 5.0.0-test --omo-ai-version 5.0.0-0.beta.test
  --out-dir /tmp/omo-pr8538-migration-binary-final` completed with:
  `built darwin-arm64 ... (110474354 bytes, 751 embedded sidecar files)`.

The generated `bin/lib/migration-runtime.js` is explicitly ignored. Both
native payload staging and compiled-binary staging invoke
`buildMigrationRuntime()` first. The generated bundle contains config-core and
js-yaml, while the provider aliases are injected from the existing
`provider-map.json` at build time (no runtime JSON file lookup).

## Manual compiled CLI QA

On a fresh temporary `HOME` and state directory:

- `omo migrate --help` printed `Usage: omo migrate [--dry-run|--yes]`.
- `omo migrate --not-an-option` exited 1 with
  `unknown migrate argument: --not-an-option`.
- `omo migrate --yes` completed and wrote:
  - `settings.json`: `defaultProvider: "azure-openai-responses"`,
    `defaultModel: "gpt-5"`, and `permission: { "*": "ask" }`.
  - `keybindings.json`: `app.session.new` alternatives
    `["ctrl+n", "ctrl+shift+n"]`.

## Unrelated observed failure

`bun test script/build-omo-native.test.ts script/build-omo-binary.test.ts
packages/omo-native/test/package-shape.test.ts` produced `67 pass, 1 fail`.
The failure is the pre-existing binary sidecar assertion for
`plugin/skills/ast-grep/SKILL.md`; the native plugin build did not produce that
unowned generated plugin artifact. Migration tests, payload build, and the
compiled migration artifact above are green.

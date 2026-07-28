# QA summary - issue #6376 - ast-grep provisioning resolves the wrong skills directory

Captured 2026-07-28 (UTC) on Windows 11, bun 1.3.14, node v22.14.0, opencode 1.18.5.
Base: `upstream/dev` @ `4a6b2bed2`.

## The defect

`packages/shared-skills/index.mjs` was, in full:

```js
import { fileURLToPath } from "node:url";

export function sharedSkillsRootPath() {
	return fileURLToPath(new URL("./skills/", import.meta.url));
}
```

Both build steps INLINE this module, so `import.meta.url` becomes the URL of the
*consuming bundle*, not of `packages/shared-skills/`. The build copies the shared skills
to `dist/skills` only. The result is an asymmetry between the three shipped bundles:

| bundle | sits at | `sharedSkillsRootPath()` returns | correct? |
|---|---|---|---|
| `dist/index.js` (plugin) | `dist/` | `dist/skills/` | yes |
| `dist/cli/index.js` | `dist/cli/` | `dist/cli/skills/` | **no, does not exist** |
| `dist/cli-node/index.js` | `dist/cli-node/` | `dist/cli-node/skills/` | **no, does not exist** |

`bunx oh-my-openagent install` runs from the CLI bundle, so `installAstGrepForOpenCode`
(`packages/omo-opencode/src/cli/install-ast-grep-sg.ts:26`) looked for the installer at
`dist/cli/skills/ast-grep/install.sh`, did not find it, and logged
`[ast-grep] skipped sg provisioning: missing .../dist/cli/skills/ast-grep/install.sh`.
`sg` was therefore never provisioned and `doctor` subsequently reported
`AST-Grep unavailable`, exactly as reported.

## The change

One product file, `packages/shared-skills/index.mjs` (+8 / -1):

```js
export function sharedSkillsRootPath() {
	const sibling = fileURLToPath(new URL("./skills/", import.meta.url));
	if (existsSync(sibling)) return sibling;
	const parent = fileURLToPath(new URL("../skills/", import.meta.url));
	return existsSync(parent) ? parent : sibling;
}
```

Three deliberate properties:

1. **Sibling first.** Every layout that works today (the source tree, and the `dist/`
   plugin bundle) finds `./skills/` on the first probe and returns byte-identically to
   before. The only behavioral change is the case where the sibling is absent and the
   parent is present, which is precisely the broken CLI-bundle case.
2. **Bounded to exactly one level.** A generalized parent walk could bind to an unrelated
   ancestor `skills/` directory and silently change behavior in trees that work today.
   Every real bundle is at depth 0 or depth 1.
3. **Neither present returns the sibling path, unchanged.** The signature is
   `(): string` and never throws; callers already tolerate a missing directory and print
   their own diagnostics. Returning the sibling keeps every existing error message
   pointing at the same primary location.

## Defect class

Four call sites share the single chokepoint, so fixing the function covers all of them:

| consumer | runs from | status before |
|---|---|---|
| `omo-opencode/src/cli/install-ast-grep-sg.ts:26` | CLI bundle | **actively broken** (this issue) |
| `skills-loader-core/.../builtin-skills/skill-file-loader.ts:10` | plugin bundle | latent |
| `skills-loader-core/.../opencode-skill-loader/loader.ts:170` | plugin bundle | latent |
| `skills-loader-core/.../merger/builtin-skill-converter.ts:11` | plugin bundle | latent |

Only the first is observably broken today, because it is the only one that runs from a
non-root bundle. The other three load from `dist/index.js`, which resolves correctly, but
they share the same defect and would break from any future non-root bundle. Patching only
the ast-grep call site would have left them exposed.

## What was tested, and what was observed

| # | Scenario | Artifact | Observed |
|---|---|---|---|
| RED | New tests on unmodified base | `red-6376.txt` | 2 pass / 1 fail. The bundle-one-level-below case returned `<tmp>\cli\skills` where `<tmp>\skills` was expected - the same divergence as `dist/cli/skills` vs `dist/skills`. Behavioural failure, not a compile error. |
| GREEN | Same tests with the fix | `green-6376.txt` | 3/3 pass. |
| Negative control | Revert only the product file, keep the tests | `negative-control-6376.txt` | The same case fails again (exit 1). |
| Typecheck | `tsgo --noEmit -p packages/omo-opencode` | `typecheck-6376.txt` | exit 0. |
| Regression | 3 suites, clean base vs PR | `regression-comparison.txt` | No new failures. See below. |
| **Built artifact** | **the real `dist/` bundles** | `live-driver.sh`, `live-driver-before.txt`, `live-driver-after.txt` | See below. |
| Isolation | sandbox + DB proof | `db-session-count-proof.txt` | driver delta 0 sessions. |

### Regression sweep

| suite | clean `upstream/dev` | with this PR |
|---|---|---|
| `packages/shared-skills` | 68 pass / 1 fail (the new RED case) | **69 pass / 0 fail** |
| `packages/skills-loader-core` | 235 / 0 | 235 / 0 |
| `packages/omo-opencode/src/cli` | 659 pass / **2** fail | 659 pass / **2** fail |

The two `cli` failures are `executeOnCompleteHook > uses powershell when PowerShell is
detected on Windows` and its cmd.exe counterpart. They fail identically on unmodified
`upstream/dev` on this Windows host and are unrelated to skill path resolution.

### Built artifact: the only surface where this bug exists

The bug cannot be reproduced from source, because running from
`packages/omo-opencode/src/cli/index.ts` resolves `import.meta.url` to the source tree,
where `packages/shared-skills/skills` is a real sibling. The proof therefore has to drive
the built output. `bash live-driver.sh <out>` runs `bun run build`, then for each shipped
bundle directory places a copy of the shipped `index.mjs` in that exact directory and
imports it, so its `import.meta.url` reproduces that bundle's own resolution against the
real built assets.

```
                      BEFORE                              AFTER
dist/index.js         dist\skills\        FOUND           dist\skills\   FOUND   (unchanged)
dist/cli/index.js     dist\cli\skills\    MISSING         dist\skills\   FOUND
dist/cli-node/...     dist\cli-node\...   MISSING         dist\skills\   FOUND
```

The `ast-grep/install.sh` asset is reported FOUND from every bundle location after the
change and MISSING from both CLI bundles before it. The inlined literals confirm the
fallback actually ships:

```
                      BEFORE                         AFTER
dist/index.js         "./skills/"=1  "../skills/"=0   "./skills/"=1  "../skills/"=1
dist/cli/index.js     "./skills/"=1  "../skills/"=0   "./skills/"=1  "../skills/"=1
dist/cli-node/...     "./skills/"=1  "../skills/"=0   "./skills/"=1  "../skills/"=1
```

The driver also runs the real `node dist/cli-node/index.js doctor` in the sandbox, which
completes normally in both captures.

Note on `doctor` as an observable: `checkAstGrepCli` only reports whether the `sg` binary
was already provisioned into the runtime directory; it does not perform provisioning, and
real provisioning downloads a binary. `doctor` is therefore a downstream readout, not a
discriminator for this fix, so the deterministic bundle-resolution proof above is the
primary evidence rather than a doctor diff.

### Isolation

The driver redirects `HOME`, `USERPROFILE`, `APPDATA`, `LOCALAPPDATA` and every `XDG_*`
variable into a `mktemp -d` sandbox removed on exit, and deletes its probe files. The real
opencode session table was 2729 before and 2729 after both captures, with an equal ambient
control gap also at 2729, so the QA added zero sessions.

## Why this is enough

The unit tests drive the real shipped `index.mjs` artifact rather than a reimplementation,
by copying it into controlled fixture layouts so that its own `import.meta.url` selects the
branch under test. That is the same mechanism the bundlers use. The built-artifact capture
then shows the actual user-facing failure and its resolution on the real `dist/` output,
which is the only place the bug exists.

## Residual risk

- **Bounded to one level.** If a future build ever nests a bundle deeper than
  `dist/<one-dir>/`, resolution falls back to the non-existent sibling and the skill
  directory is silently missed again. That is deliberate: a deeper nesting is a visible
  build change that should revisit this function, whereas an unbounded parent walk could
  bind to an unrelated `skills/` directory and break layouts that work today.
- **Two `stat` calls** on the fallback path. The function is called once per module init,
  once per install and once per skill-discovery pass, never in a tight loop, and a sibling
  consumer already `existsSync`-probes the same result, so this is not memoized.
- **Symlinks.** `existsSync` follows symlinks, so a broken `./skills` symlink is treated as
  absent and the parent is used. Acceptable.
- **Assets are not duplicated.** The CLI bundles now read the shared `dist/skills`
  directory rather than getting their own copy. `dist/skills` is present in any complete
  build output, and resolution happens at runtime, so build-step ordering does not matter.
- **Unaffected surfaces.** The committed `packages/omo-senpi/plugin/extensions/omo.js`
  contains zero occurrences of this code, so the `senpi-compatibility` job is untouched;
  the Codex skill sync script runs from source and is unchanged.

## What was omitted

No secrets, tokens or environment dumps. The isolation record contains only a session
count and file paths. The driver writes into a `mktemp -d` sandbox removed on exit and
removes the probe files it copies into `dist/`.

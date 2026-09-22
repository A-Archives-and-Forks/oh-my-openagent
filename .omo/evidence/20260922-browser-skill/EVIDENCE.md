# QA evidence — the shipped `browser` skill (#8668)

Worktree: `omo-wt-browser-skill`, branch `feat/8668-browser-skill`, base `origin/dev` @ fae562252.

## What was tested

1. **The packaging contract.** Does a payload that loses the browser skill fail installation closed,
   the same way a payload missing the conditional x-search skill does?
2. **The de-personalization gate.** Does the shipped tree carry operator-specific material, and do
   the four new deny rules actually catch what they claim?
3. **The retired-browser-tool gate.** Does the new tree reintroduce guidance this repo removed in
   #8251 / #8293?
4. **Both editions materialize it.** Does `sync-skills.mjs` carry the skill into the senpi AND the
   codex plugin trees without a registration change?
5. **The doctor on a real machine**, in both states it can reach.

## What was observed

### 1. Packaging contract — RED then GREEN

RED, before `skills/browser/SKILL.md` was added to `REQUIRED_PLUGIN_ARTIFACTS`:

```
294 |     await expect(install).rejects.toThrow("missing required runtime artifacts")
error: expect(received).rejects.toThrow(expected)
Expected promise that rejects
Received promise that resolved: Promise { <resolved> }
(fail) #given a packed plugin missing the browser skill #when installing #then artifact validation fails before settings change
 0 pass | 1 fail
```

The installer accepted a payload with no browser skill — the exact defect the test exists to catch.

GREEN, after the one-line addition to `plugin-artifacts.ts`:

```
(pass) #given a packed plugin missing the browser skill #when installing #then artifact validation fails before settings change [8.00ms]
 15 pass | 0 fail | 39 expect() calls
```

### 2. De-personalization gate — extended, mutation-proved

`packages/shared-skills/depersonalization-gate.mjs` already owned this contract for three skills, so
the browser tree was added to its scan list rather than given a second scanner. Four deny rules were
added: `email-address`, `share-link`, `url-token-fragment`, `credential-env-path`.

Before adding them, the three already-scanned skill trees were checked against the new patterns to
prove the rules do not fire on existing content: **0 hits**, so a failure afterwards means the new
content, not a newly strict rule.

Mutation proof — a seeded file containing a share link, a token-bearing URL, a mail address and a
credential env path, plus one ordinary anchor URL as a control:

```
(pass) #then a secret-sharing link, a token-bearing url and an operator mail address are caught
 4 pass | 0 fail | 11 expect() calls
```

The control matters: `url-token-fragment` matched exactly once, so `https://example.com/docs#installing-the-cli`
does not trip it. A rule that flagged every anchor link would be unusable and would have been
"green" without that assertion.

The real browser tree scans clean in the same run.

### 3. Retired browser tools

```
(pass) ships no retired browser tool instructions [375.46ms]
 1 pass | 0 fail | 55 expect() calls
```

Scanned over the working-tree bytes of both generated payloads, not the git index.

### 4. Both editions

```
(pass) browser skill is materialized into both shipped editions
 5 pass | 0 fail
```

`diff -r` between the source tree and the senpi payload: **identical**. The codex payload differs by
exactly one generated path (`agents/`, the Codex role declaration its sync writes for every skill).

### 5. The doctor, on real machines

Local machine, no CLI installed:

```json
{ "state": "no-cli", "platform": "darwin",
  "remedy": "Install the CLI: node \"<skill-root>/scripts/browser-install.mjs\", then re-run this doctor." }
```

exit 1.

A second machine that has the CLI, the daemon and a connected browser:

```json
{ "state": "ready", "platform": "darwin", "cli": "<home>/.local/bin/bsk", "browsers": 1,
  "remedy": "Start a session: bsk session start --json --no-focus --name \"<task>\"" }
```

exit 0. Both states are real observations, not simulated.

### Type gates

`bun run typecheck:script` -> exit 0. `tsgo --noEmit -p packages/omo-senpi/tsconfig.json` -> exit 0.

## Why it is enough

The three ways this change can break a user are: the skill silently vanishes from a published
payload (covered by the artifact contract, RED-proved), it leaks operator material into a public
package (covered by the de-personalization gate, mutation-proved), or it reintroduces guidance this
repo deliberately retired (covered by the existing tool gate). The doctor is the only new runtime
surface and it was run on real machines in both reachable states.

## What was omitted, and why

- **No THIRD-PARTY-NOTICES.md entry.** `scripts/check-third-party-notices.mjs --ship` passes as-is
  and is correct to: that file enumerates components this package **redistributes**, and this skill
  redistributes none of BrowserSkill — no CLI, no daemon, no extension, no source. The attribution
  belongs in the skill's own `ATTRIBUTION.md`, which is the pattern `ultimate-browsing` already uses.
  Adding a notice entry for software we do not ship would make that file less accurate, not more.
- **No test pins the skill's prose.** Per `.omo/rules/test-discipline.md`, a skill body is
  instructions a model reads. Only machine-consumed values are asserted: the frontmatter `name`
  (the loader reads it, and it is the anti-shadowing contract), the absence of a `name` in reference
  docs, the payload shape, and the manifest membership.
- **The `no-extension` doctor state was not captured live.** Reaching it means disabling the
  extension in someone's running browser; the state is a pure branch on an empty `browsers` array
  from `bsk status --json`, reached by the same code path as `ready`.
- **Biome was not used as a gate.** The repo has no root `biome.json` and no lint script; an
  unchanged tracked file reports the same errors under `bunx @biomejs/biome check`, so that
  invocation resolves a config this codebase does not use. `tsgo` is the gate that exists.


---

## CI rounds — what the shipped-set duplication actually cost

Adding one skill required registering it in seven places. They live in different packages, so each
one only fails once the earlier one is fixed, and CI surfaced them one round at a time.

### Round 1 — 4 failures

| Check | Actual reason (read from the log, not the name) | Verdict |
|---|---|---|
| `senpi-compatibility` | `build-install.mjs --check`: the committed installer embeds `REQUIRED_PLUGIN_ARTIFACTS` and was stale | mine |
| `codex-compatibility` | `sync-skills-test-support.mjs` `expectedSkills` omitted `browser` | mine |
| `test (ubuntu 2/2)` | `senpi-test-script.test.ts` packed-layout fixture omitted `browser` | mine |
| `test (ubuntu 1/2)` | `auto-update-checker > getLatestVersion` received `3.0.1` | unclassified |

The fourth was NOT called pre-existing. The dev baseline run on the same workflow failed only on the
**windows** shards; ubuntu was green, so "pre-existing" had no evidence behind it. It was left
unclassified and handed to the next CI round rather than guessed at.

### Round 2 — 1 failure

The three fixes landed and `auto-update-checker` **cleared on its own**, which classified it: it was
downstream of those defects perturbing the run, not an independent mock leak. Remaining:

| Check | Actual reason | Verdict |
|---|---|---|
| `senpi-compatibility` | three more lists: `BUILTIN_SKILL_NAMES`, `expectedSkillNames`, `cli-local` fixture | mine |

`BUILTIN_SKILL_NAMES` is the important one. It is **not** a test list — it backs the
`skill_loaded.skill_name` property allowlist, so a skill missing from it has its usage events
silently dropped. A test-only fix would have shipped that data loss behind a green suite. Changing it
regenerates exactly one line of the byte-pinned telemetry doc block:

```
| `skill_loaded` | `skill_name` | `string` | `ast-grep`, `browser`, `coding-agent-sessions`, ... |
```

### Round 3 — pushed with all seven registered

Before pushing, the repo was swept proactively for further drift sites using `"ultimate-browsing"` as
the anchor (every shipped-set list contains it). Nineteen files matched; nine lacked `browser`, and
all nine are `ultimate-browsing`-specific references — the `ulw-research` companion routing in
`skill-pointers`, the engine runtime pins, and landing copy — not set enumerations. No further drift
sites exist.

**Local full package gate before the round-3 push:**

```
bun test packages/omo-senpi
 3731 pass | 32 skip | 0 fail | 13932 expect() calls
Ran 3763 tests across 450 files. [240.78s]
```

The duplication itself is filed as #8670 with the full seven-site table.

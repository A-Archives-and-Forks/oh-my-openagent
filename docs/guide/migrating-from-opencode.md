# Migrating from OpenCode

You've been running omo as the OpenCode plugin (oh-my-openagent 4.19.x, or a 5.x beta) and want the standalone `omo` command instead. This page walks that move, one command per step. Nothing here touches OpenCode itself: the plugin keeps working until you remove it, and you can run both side by side for as long as you like.

The standalone edition is called **OmO Native**. It ships as the npm package `omo-ai`, installs one command (`omo`), and runs a pinned senpi engine with the OMO extension built in. No host app, no plugin registration.

Sections:

- [Before you start](#before-you-start)
- [Install](#install)
- [Setup](#setup)
- [Your first session](#your-first-session)
- [Keeping OpenCode around](#keeping-opencode-around)
- [Updating and uninstalling](#updating-and-uninstalling)

## Before you start

oh-my-openagent and oh-my-opencode 4.19.4 and earlier install their own global command named `omo`. That's the OpenCode-edition CLI, not the standalone omo, and it occupies the name the new package needs. Check what `omo` is on your machine right now:

```bash
omo --version
```

A bare version such as `4.19.4` means the legacy package still owns the name. OmO Native answers with `omo 5.0.0-0.beta.NN (engine: senpi ...)` instead.

To see whether npm installed the legacy copy:

```bash
npm ls -g oh-my-openagent oh-my-opencode
```

If bun installed it instead, it sits under `~/.bun/install/global/node_modules/`. Either way, `omo doctor` names the package, its version and the directory once OmO Native is in, so you don't have to hunt for it now.

You don't have to remove anything before installing. The installer in the next step handles the stale command for you.

You need bun (recommended) or npm, and Node 24 or newer. Everything below uses bun; where npm differs, the note says so.

## Install

Run the installer, not a raw `bun add -g`:

```bash
bunx oh-my-openagent@beta install --platform=native
```

Without bun, use `npx oh-my-openagent@beta install --platform=native`. The `@beta` tag is required either way: `latest` is still 4.19.4, and that release has no `native` platform.

What the command does, in order:

1. Looks for a global `omo` owned by oh-my-openagent, oh-my-opencode or lazycodex and removes that one file. The package that owns it and every other command it installs stay in place. An installer doesn't get to uninstall someone's whole global package.
2. Runs `bun add -g omo-ai@beta` (or `npm i -g omo-ai@beta`).
3. Checks that `omo --version` on your PATH now answers as omo-ai. If another `omo` still shadows it, the installer prints the exact `export PATH="...:$PATH"` line that fixes the order.
4. Offers to run `omo setup` right away. With `--no-tui` it prints the command to run instead.

Why the raw install isn't enough on an older machine: npm refuses to overwrite the existing `omo` (EEXIST), and bun installs beside it, so `omo --version` keeps printing `4.19.4`. The installer removes the stale command first.

If you already ran `bun add -g omo-ai@beta` by hand and the old `omo` still wins, run the installer line anyway. It's idempotent, and it prints the repair it made.

## Setup

```bash
omo setup
```

Setup reads your OpenCode state, prints one summary of everything it would carry over, asks one question, and writes only after you answer yes. Run it as often as you like: a second run finds nothing new and writes nothing.

Where it reads from: OpenCode's `auth.json` (`~/.local/share/opencode/auth.json`, XDG-aware) and OpenCode's user-scope config, merged the way OpenCode merges it (`~/.config/opencode/config.json`, `opencode.json`, `opencode.jsonc`, then `$OPENCODE_CONFIG`, `~/.opencode/` and `$OPENCODE_CONFIG_DIR`). Nothing is written back to those files.

Where it writes to: `~/.omo/agent/` (`auth.json`, `mcp.json`, `models.json`, `settings.json`, `skills/`) and `~/.omo/omo.jsonc`. Each file gets a timestamped backup before it's rewritten, and an entry that already exists in omo is never overwritten.

### What comes across

| From OpenCode | Into omo | Notes |
|---|---|---|
| API keys in `auth.json` | `~/.omo/agent/auth.json` | Provider ids are translated where they differ: `kimi-for-coding` lands on `kimi-coding`, `zai-coding-plan` on `zai`. |
| Custom providers (`provider.<id>` blocks) | `~/.omo/agent/models.json`, key into `auth.json` | Base URL, models, context and output limits, headers. The `npm` package picks the protocol: `@ai-sdk/openai-compatible` (also the default when `npm` is missing), `@ai-sdk/anthropic`, or `@ai-sdk/openai`. The key comes from `options.apiKey`, else the provider's `auth.json` entry, else the single variable its `env` names. `{env:NAME}` becomes `${NAME}`. |
| MCP servers (`mcp` block) | `~/.omo/agent/mcp.json` | Local and remote servers, headers, `enabled: false`, OAuth client id and scopes. Global, so they're available in every project. |
| Global skills (`skills/` or `skill/` under a config dir) | `~/.omo/agent/skills/` | Copied by name. A skill omo already bundles is skipped. |
| Default `model` | `~/.omo/agent/settings.json` and `[native].model_profile` in `~/.omo/omo.jsonc` | What interactive sessions start on, and what headless sessions start on instead of the Recommended profile. |
| `categories` and `agents` from `oh-my-openagent.json[c]` / `oh-my-opencode.json[c]`, and `agent.<name>.model` from `opencode.jsonc` | `[native].categories` / `[native].agents` in `~/.omo/omo.jsonc` | Also read from the `[opencode]` block of `omo.jsonc` and from the `~/.omo/migration-backup-*-opencode-config/` copy the config migration moved the legacy files to. `fallback_models` is folded into `models`. Every provider/model is checked against what the engine serves, including a custom provider carried in the same run. |

### What needs `/login`

OAuth logins (Anthropic, GitHub Copilot, a ChatGPT-plan `openai` login) are provider-bound tokens and can't be copied. Setup lists each one and the command to run inside omo: `/login anthropic`, `/login github-copilot`, `/login chatgpt-subscription` (for an OpenCode `openai` OAuth login). A model choice on one of those providers is carried to the provider you're told to log in to, so `openai/gpt-5.5` on a ChatGPT login becomes `chatgpt-subscription/gpt-5.5`.

An API key for a provider omo doesn't serve is reported the same way: define the provider and its `baseUrl` in `~/.omo/agent/models.json`, then `/login <provider>`.

### What it refuses, and why

Each refused item is named in the summary with its reason and the fix.

- An MCP server whose config uses command substitution (`$(...)`, or a value starting with `!`). The engine rejects any such string and one bad value fails the whole `mcp.json`, so the server is left out. Resolve the value to a literal or a `${NAME}` environment reference and add the server by hand.
- An MCP server using a `{file:...}` placeholder, or an `{env:...}` name that isn't a plain identifier. omo has no spelling for those; put the value in an environment variable and reference it as `${NAME}`.
- A skill directory with no `SKILL.md` at its top level, or a `SKILL.md` without a `description` in its frontmatter. The engine wouldn't load it, so copying it would report an import the next session never shows.
- A custom provider that uses an AI SDK package other than the three above, has no fixed base URL, or declares no usable model.

### What isn't carried, and why

- `small_model`: omo has no small-model setting.
- OpenCode's own primary agents `build` and `plan`: omo's main session has no per-mode agent, it runs the default model.
- An agent name omo doesn't have (for example `oracle`): omo's agents are `explore`, `librarian`, `plan-consultant`, `plan-reviewer` and the three `omo-native-*` reviewers. Route that work through a category instead. Setup names each dropped one rather than creating a promptless agent of that name.
- Overrides on a provider omo already serves (a custom `baseURL` for `openai`, say): set them in `models.json` by hand if you need them.
- OpenCode UI settings (`theme`, `share`, `autoupdate`, keybinds), tool permissions and OpenCode plugin hooks: these belong to OpenCode's TUI and plugin system and have no counterpart in the engine.

### Consent, flags, repeats

Setup asks once for the whole plan (`Import all of the above into ~/.omo? [Y/n]`). `--yes` answers it for you, `--dry-run` prints the summary and exits without writing, `--ask-each` asks one question per class instead. Without a terminal, setup prints the summary and tells you to re-run with `--yes` rather than guessing.

Setup is idempotent. Run it again after you've added something to OpenCode and only the new items are offered.

## Your first session

```bash
omo
```

The session starts on the default model setup carried over. If setup listed OAuth logins, run their `/login` lines now.

The habits map like this. Every entry in the right column is a command or key the pinned engine ships.

| OpenCode habit | In omo |
|---|---|
| `/models` (pick a model) | `/model`, or `Ctrl+L`. `Ctrl+P` cycles to the next model. |
| `/connect` (sign in to a provider) | `/login <provider>`; `/logout <provider>` to sign out. |
| `/sessions` (open an earlier session) | `/resume`. `/fork` branches the current one, `/tree` shows the branch tree. |
| `/new` | `/new` |
| `/compact` | `/compact`, with optional instructions after it. |
| `/share` | `/share` |
| `/export` | `/export` |
| `/help` | `/hotkeys` lists every key; `/settings` opens the settings list. |
| `/editor` (compose in $EDITOR) | `Ctrl+G` |
| `/details` (show or hide tool output) | `Ctrl+O` |
| `/exit` | `/exit` or `/quit`, or `Ctrl+D` on an empty prompt. |
| `@file` (attach a file) | `@path`, with fuzzy suggestions; `Tab` accepts the highlighted one. |
| `!command` (run a shell command) | `!command`. `!!command` runs it without adding the output to the context. |
| `Tab` (switch between build and plan) | No equivalent. omo has one main session; `Shift+Tab` cycles the thinking level instead. Categories and agents you carried over live in `~/.omo/omo.jsonc` and drive delegation, not the main session. |
| `/agents` | No equivalent. See the row above. |

## Keeping OpenCode around

You don't have to choose. The OpenCode plugin keeps loading and working exactly as before; the two editions share nothing on disk except what setup copied, and setup never writes back.

`omo doctor` tells you what's still installed:

```bash
omo doctor
```

Three lines matter here.

- `WARN another omo precedes omo-ai on PATH ...`: a stale legacy `omo` still wins. The line names the fix (the installer command from above, or removing that one file).
- `WARN legacy package oh-my-openagent@4.19.4 is still installed globally ...`: informational until you decide to remove it. The line gives the remove command for the package manager that installed it.
- `INFO OpenCode still loads the oh-my-openagent plugin (~/.config/opencode/opencode.jsonc)`: this is the coexistence case. Keep it if you still use OpenCode; otherwise remove the plugin entry.

To stop OpenCode loading the plugin, delete `"oh-my-openagent"` (or `"oh-my-opencode"`, or the `@latest`-tagged spelling) from the `plugin` array of the file the INFO line names. It's usually `~/.config/opencode/opencode.json` or `opencode.jsonc`, and `tui.json` if you registered it there too. Nothing else needs to change.

## Updating and uninstalling

Update omo with its own command:

```bash
omo update
```

It prints the package-manager line it runs (`bun add -g omo-ai@beta`, or `npm i -g omo-ai@beta` for an npm install) and then the version change. `omo update --print` shows the line without running it. The engine is pinned by the package, so this is the only update path; there's no separate engine update.

Removing the legacy package once you're settled:

```bash
bun remove -g oh-my-openagent
```

bun leaves omo-ai's `omo` alone. npm doesn't: `npm uninstall -g oh-my-openagent` unlinks every bin name that package declared, including the `omo` that an npm-installed omo-ai now owns. If you go the npm route, run `npm i -g omo-ai@beta` right after it to put the command back. The installer prints this same warning when it repairs an npm-owned legacy `omo`.

Removing OmO Native itself:

```bash
bun remove -g omo-ai
```

(or `npm uninstall -g omo-ai`). On a bun install, omo-ai replaces bun's `omo` symlink with a small launcher shim so each start skips a node boot, and `bun remove` leaves that file behind; delete it with `rm ~/.bun/bin/omo` (the shim says so in its header). Your state under `~/.omo/agent/` and `~/.omo/omo.jsonc` stays on disk; delete it yourself if you want a clean slate. The OpenCode plugin, if you kept it, is unaffected.

See also: [Installation](./installation.md#omo-native-beta-omo-via-omo-ai) for where omo keeps its state, and [Agent Model Matching](./agent-model-matching.md) for choosing models per category.

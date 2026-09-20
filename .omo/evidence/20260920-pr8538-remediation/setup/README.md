# Setup remediation receipt

## Scope and isolation

The real `node packages/omo-native/bin/omo.js setup --yes` ran with HOME,
USERPROFILE, all three OMO/SENPI/PI agent-directory variables, and XDG directories
redirected into this fixture. OMO_RUNTIME=node. Values are fabricated; no MCP
connection or provider request was made.

## Regression tests

Changed setup tests ran against this worktree from an isolated test cwd, without
unrelated repository adapter preloads.

- Initial RED: 14 pass, 1 skip, 7 fail. Failures were credential writes before
  malformed MCP rejection, invalid MCP object acceptance, untranslated variable
  references, imported file references, and wrong OAuth login IDs.
- First GREEN: 21 pass, 1 skip, 0 fail.
- Additional rollback RED: a real FIFO inside a skill makes cpSync fail after
  credentials/MCP writes; original target bytes were not restored.
- Final GREEN: 22 pass, 1 skip, 0 fail across setup-import.test.ts and
  setup-content-import.test.ts. FIFO failure now restores original target bytes
  and removes the partially copied new skill.

The skip is the existing node:sqlite case on Bun 1.3.14.

## Real launcher output

Exit 0, empty stderr. Relevant stdout:

```text
skipped-oauth: anthropic
skipped-gateway: opencode
skipped-unmapped: unknown-oauth
mcp-planned-add: local, remote
imported: 0
skipped-oauth: 1
skipped-gateway: 1
skipped-unmapped: 1
Run '/login anthropic' to re-authenticate.
mcp-imported: 2
skills-imported: 0
agents-md: absent
```

## Real consumer

Called the exact installed Senpi `dist/core/extensions/builtin/mcp/config.js`
`loadMcpConfig` with this agent directory, isolated cwd, projectTrusted=false,
and `{REVIEW_MCP_TOKEN: "DUMMY_RESOLVED"}`.

- diagnostics: []
- local: enabled, stdio, command=node, args=["dummy-mcp.js"],
  env.TOKEN=DUMMY_RESOLVED
- remote: enabled, http, url=https://example.test/mcp,
  headers.Authorization="Bearer DUMMY_RESOLVED"

The source and resulting mcp.json are retained beside this receipt. The loader
resolved the migrated references rather than accepting their JSON shape alone.
Rollback is for caught write errors; abrupt process termination is not claimed
to be transactionally atomic across files.

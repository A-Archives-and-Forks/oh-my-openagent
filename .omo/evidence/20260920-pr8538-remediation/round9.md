# Default native build preserves the generated-runtime ignore rule

The eighth review accepted runtime migration and reproduced a default-output build
that overwrote .gitignore with only /plugin/. The new real-build regression was
observed RED: 0 pass, 1 fail on the changed ignore bytes.

The builder no longer rewrites a tracked source file. Its checked-in rules remain
authoritative, avoiding another duplicated list that could drift again. The test
checks unchanged ignore bytes, both ignored outputs and unchanged git status;
its finally block restores the starting bytes if a future regression mutates them.

## Verification

- Exact Bun 1.4.0: 430 pass, 0 fail, 1360 assertions, 45 files (complete native
  suite plus script/build-omo-native.test.ts).
- Separate real command `bun run build:omo-native`: exit 0, default package plugin
  path, all 38 required artifacts present.
- Before/after `git status --porcelain` were byte-identical:

```text
 M .omo/evidence/omo-senpi-adapter/20260902-memorian-nudged/C001-happy/transcript-ansi.txt
 M changes.md
 M packages/omo-native/test/payload.test.ts
 M script/build-omo-native.ts
```

- Before/after ignore bytes were identical:

```gitignore
/plugin/
/bin/lib/migration-runtime.js
```

- `git check-ignore --quiet` exited 0 separately for the plugin directory and
  generated migration runtime.
- Native tsc: the same six existing node:sqlite errors. Script tsc: the same
  existing ArrayBuffer/SharedArrayBuffer error at utils/runtime/file.ts:35.
- Changed build-script LSP diagnostics were clean.
- No runtime implementation changed in this iteration. The round-8 actual
  Node/compiled CLI and 72-case native-consumer receipts remain applicable; the
  new real-surface check is the default build, not a fabricated new binary claim.
- The eighth review worktree was removed without tracked changes.

# Final QA

## What was observed

- The three reviewer regressions failed before production edits:
  - newer draft was replaced with an empty string;
  - New BTW used `ses_other` instead of the picker parent;
  - Escape handling had no injectable clock.
- Focused GREEN checks then proved:
  - the newer draft survives catalog completion;
  - New BTW metadata keeps the encoded `ses_parent`;
  - an Escape after 1,001 ms starts a new pair, while the next Escape after
    99 ms returns once.
- The real TUI returned from the side to Main after two Escape presses 500 ms
  apart and displayed `BTW retained`.
- Isolated SQLite contained:
  - Main `ses_fdd7cb126ffeqrc131gwQ89nzb`;
  - side `ses_fdd7cabfbffeGtC15w2KGCTaWN`, whose metadata parent is Main.
- Host OpenCode session count was `7614` before and `7614` after.

## Why it is enough

The focused tests pin the exact asynchronous and timing races reported by the
reviewer. The real TUI run exercises the shipped OpenTUI surface, route change,
side retention, model response, and bounded double-Escape behavior. SQLite
metadata confirms the side relationship, and the unchanged host count proves
isolation.

## What was omitted

- Raw host OMO logs contain unrelated concurrent activity and were not copied.
- Fake-model request bodies were not copied because deterministic responses
  and session metadata were sufficient.
- The isolated database, package caches, temporary HOME, and unsanitized
  terminal capture are removed after the committed evidence is staged.

# Todo 13 live root QA

What was tested: `bun test packages/omo-senpi/scripts/qa/x-search-live-e2e.test.mjs` and the new driver against the real `senpi` binary with the freshly staged plugin. Negative, positive, and reload scenario outputs are under the scenario directories.

Observed: negative reports no x-search and no conditional x-search skill; positive reports tool_search activation followed by one real x_search execution and x.com results; reload reports two executions across a session continuation/reload sequence and three registrations (one per process load). Every run reports `realSenpiUntouched=true` and seeded credentials are shredded before sandbox removal.

Omitted: credential values, auth contents, and unredacted environment/transcript material.

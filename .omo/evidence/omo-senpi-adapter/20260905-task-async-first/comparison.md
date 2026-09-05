# GPT-6 Astra async-first backtest - old vs new (2026-09-05)

Real model: gpt-6-astra via the ChatGPT codex backend (senpi openai-codex path), reasoning high, one round trip per sample, first response only. System prompt rendered through senpi's real resolvePreset with the omo task tool attached (snippet + Tool Guidelines + schema), plus the <omo-senpi-task> block. Requests never mention background/foreground/async.

- r2: single dependent delegation (deep fixes a scheduler bug, then the orchestrator runs the dag suite itself)
- r3: sequential decision then implementation (ultrabrain decides, then deep implements)
- r1: three independent research tracks (fan-out regression; the old text already allowed background here)

| variant/request | samples | background | foreground or mixed | no task call | http errors | per-sample task calls (target:run_in_background) |
|---|---|---|---|---|---|---|
| red/r2 | 3 | 0 | 3 | 0 | 0 | deep:false / deep:false / deep:false |
| red/r3 | 3 | 0 | 3 | 0 | 0 | ultrabrain:absent / ultrabrain:absent / ultrabrain:absent |
| preset-only/r2 | 3 | 2 | 1 | 0 | 0 | deep:true / deep:true / deep:absent |
| green/r2 | 3 | 3 | 0 | 0 | 0 | deep:true / deep:true / deep:true |
| green/r3 | 3 | 3 | 0 | 0 | 0 | ultrabrain:true / ultrabrain:true / ultrabrain:true |
| green/r1 | 3 | 0 | 0 | 0 | 3 | http_429 / http_429 / http_429 |

old = senpi main preset before #1381 + omo dev task text before this PR. preset-only = senpi #1381 preset + OLD omo task text (the tool guideline "only for parallel independent work; the default waits" and the schema "false (default)" still pulled one of three spawns back). new = senpi main 82ef1fd31 (#1381) + this PR's task text. r1 new hit HTTP 429 (rate limit) on all three attempts; rerun recorded below if it completed.

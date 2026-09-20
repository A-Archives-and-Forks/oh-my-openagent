# QA evidence — 20260920-postinstall-allow-scripts (npm allow-scripts root cause)

## WHAT WAS TESTED
Whether npm ≥ 11 actually BLOCKS omo-ai's postinstall (`bin/senpi-patch.mjs`) or merely warns.
Three real installs of `omo-ai@beta` (5.0.0-0.beta.79) into sandbox prefixes, checking the patch's
observable effect: the bundled engine ships `claudeCodeVersion = "2.1.75"` (senpi repo
packages/ai/src/api/anthropic-messages.ts:109) and the patch floors it to `2.1.251`.

## WHAT WAS OBSERVED
1. Machine config (npm 11.17.0, `allow-scripts=[""]` present in effective config): warning printed;
   patch result `claudeCodeVersion = "2.1.251"` — PATCH RAN.
2. Empty userconfig + globalconfig (fully stock): warning printed; patch result `2.1.251` — RAN.
3. Machine config, fresh prefix: warning printed; patch result `2.1.251` — RAN.
Conclusion: npm 11.17.0 prints `npm warn allow-scripts ... not yet covered by allowScripts` but
still EXECUTES install scripts; enforcement requires opting into `allow-scripts-pending` /
`strict-allow-scripts`. The wave-3 assumption that the postinstall was blocked was WRONG (the
warning was misread as a block; it was never verified before the manual run).

## WHY IT IS ENOUGH
The patch's effect is binary-observable in the installed tree (engine version string below vs at
the floor), and all three config regimes show it applied.

## WHAT WAS OMITTED
npm 12.x behavior (not yet released as the machine's default; worth one re-check before v5 GA).
Strict-allowlist regimes (`strict-allow-scripts=true`) genuinely block scripts — the installation
guide now documents `npm approve-scripts omo-ai` for those.

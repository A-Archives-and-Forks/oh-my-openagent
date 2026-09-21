# Task 6 - regenerate the plugin bundle and run the package gate

## WHAT WAS TESTED
The repository gate `bun run test:senpi` (build + typecheck + the whole omo-senpi suite + the evidence-dir CLI test) at branch HEAD, and the generated extension bundle the gate rebuilds.

## WHAT WAS OBSERVED
`GATE_EXIT=0`. 3711 pass / 0 fail in the package suite, then 10 pass / 0 fail for the evidence-dir CLI; zero `(fail)` lines anywhere in the transcript. The bundle carries thread_rename, thread_set_model and thread_set_reasoning (5 occurrences each) and `retain_on_disconnect`, with ZERO `sharedHostEnabled` tokens, and `grep -rn sharedHostEnabled packages/omo-senpi/src` is empty. Building twice - once directly, once inside the gate - produced the same sha256 `0c3a5802...`, so the committed artifact is reproducible here.

## WHY IT IS ENOUGH
The gate is the repository's own definition of green for this package and it covers every file this branch touched; the bundle greps prove the shipped artifact, not just the source, carries the new surface and no longer carries the removed gate.

## WHAT WAS OMITTED
The bundle was built on darwin/arm64. CI regenerates and freshness-checks the artifact on its own platform; if it reports drift, the fix is a rebuild on that platform, not a source change.

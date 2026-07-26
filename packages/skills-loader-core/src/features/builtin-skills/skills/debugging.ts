import { loadSharedSkillTemplate } from "../skill-file-loader"
import type { BuiltinSkill } from "../types"

export const debuggingSkill: BuiltinSkill = {
	name: "debugging",
	description:
		"MUST USE for runtime debugging in any language or binary: crashes, silent failures, wrong responses, stuck processes, leaks, async bugs, timing issues, or reverse engineering. Runs a hypothesis-driven loop: form ≥3 hypotheses, investigate in parallel, spawn orthogonal Oracles after 2 failed rounds, prove root cause, add a failing regression test, fix minimally, QA the real system, and scrub artifacts. Read `references/` for methods. Triggers: 'debug this', 'why is X not working', 'hanging', 'attach a debugger', 'reverse engineer', 'pwndbg', 'gdb', 'lldb', 'node inspect', 'tsx debug', 'pdb', 'dlv', 'delve', 'rust-gdb', 'set a breakpoint', 'context window exploded', 'why is the response empty', 'attach the debugger', 'debug it', 'why is this happening', 'trace this bug', 'reproduce and fix', 'silent failure', 'HTTP 200 but empty', 'why did it stop', 'inspect the binary', 'reverse engineering', 'playwright', 'flaky test', 'fails sometimes', 'fails intermittently', 'passes in isolation', 'only fails in CI'.",
	template: loadSharedSkillTemplate("debugging"),
}

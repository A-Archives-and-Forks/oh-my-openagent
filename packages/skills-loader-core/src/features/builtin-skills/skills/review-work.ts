import { loadSharedSkillTemplate } from "../skill-file-loader"
import type { BuiltinSkill } from "../types"

export const reviewWorkSkill: BuiltinSkill = {
	name: "review-work",
	description:
		"Post-implementation gate review. You run manual QA on the real surface yourself, then launch ONE gate reviewer sub-agent (oracle on OpenCode; the surface's gate-reviewer agent elsewhere) that audits goal, constraints, correctness, code quality, security, missed context, and your QA evidence. Passes only on a clean QA matrix plus APPROVE - one reviewer, never a panel. MUST USE before a PR handoff or when the user explicitly asks to review completed work. Triggers: 'review work', 'review my work', 'review changes', 'QA my work', 'verify implementation', 'check my work', 'validate changes', 'post-implementation review'.",
	template: loadSharedSkillTemplate("review-work"),
}

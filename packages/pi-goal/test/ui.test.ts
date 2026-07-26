import { describe, expect, it } from "bun:test";
import type { Goal } from "../src/goal/types.js";
import { composeFooterStatusLine, goalFooterIndicator } from "../src/goal/ui.js";

describe("ultragoal footer UI", () => {
	it("formats Senpi ultragoal indicator labels", () => {
		expect(goalFooterIndicator(testGoal()).text).toBe("Pursuing ultragoal (2m)");
		expect(goalFooterIndicator(testGoal({ tokenBudget: 50_000, tokensUsed: 12_500 })).text).toBe(
			"Pursuing ultragoal (12.5K / 50K)",
		);
		expect(goalFooterIndicator(testGoal({ status: "paused" })).text).toBe(
			"Ultragoal paused (/ultragoal resume)",
		);
		expect(
			goalFooterIndicator(testGoal({ status: "budgetLimited", tokenBudget: 50_000, tokensUsed: 63_876 })).text,
		).toBe("Ultragoal unmet (63.9K / 50K tokens)");
		expect(goalFooterIndicator(testGoal({ status: "complete", tokenBudget: 10_000, tokensUsed: 3_250 })).text).toBe(
			"Ultragoal achieved (3.3K tokens)",
		);
	});

	it("right-aligns the goal indicator on the bottom footer line", () => {
		const line = composeFooterStatusLine("", "Pursuing goal (2m)", 32);

		expect(line).toHaveLength(32);
		expect(line.endsWith("Pursuing goal (2m)")).toBe(true);
		expect(line.trimStart()).toBe("Pursuing goal (2m)");
	});

	it("keeps other extension statuses on the left when the goal indicator fits", () => {
		const line = composeFooterStatusLine("review ready", "Ultragoal paused (/ultragoal resume)", 62);

		expect(line).toHaveLength(62);
		expect(line.startsWith("review ready")).toBe(true);
		expect(line.endsWith("Ultragoal paused (/ultragoal resume)")).toBe(true);
	});
});

function testGoal(overrides: Partial<Goal> = {}): Goal {
	return {
		id: "goal-1",
		threadId: "thread-1",
		objective: "Port /ultragoal as a Senpi extension",
		status: "active",
		tokensUsed: 0,
		timeUsedSeconds: 120,
		createdAt: 1_777_766_400,
		updatedAt: 1_777_766_400,
		...overrides,
	};
}

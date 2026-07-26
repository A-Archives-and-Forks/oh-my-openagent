import { describe, expect, it } from "bun:test";

import { validateObjective } from "../src/goal/validation.js";

describe("validateObjective", () => {
	it("accepts objectives well beyond the former 4,000-character limit", () => {
		const objective = "목표".repeat(10_000);

		expect(validateObjective(objective)).toBe(objective);
	});

	it("still rejects an empty objective after trimming", () => {
		expect(() => validateObjective(" \n\t ")).toThrow("objective must not be empty");
	});
});

export function validateObjective(value: string): string {
	const objective = value.trim();
	if (objective.length === 0) throw new Error("objective must not be empty");
	return objective;
}

export function validateTokenBudget(value: number | null | undefined): number | null | undefined {
	if (value === undefined || value === null) return value;
	if (!Number.isSafeInteger(value) || value <= 0) throw new Error("tokenBudget must be a positive safe integer");
	return value;
}

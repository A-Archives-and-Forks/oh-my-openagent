import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";

const [mode, ...args] = process.argv.slice(2);

if (mode === "hold-lock") {
	const [lockPath, statePath, malformed] = args;
	if (lockPath === undefined || statePath === undefined) {
		throw new Error("hold-lock paths are required");
	}
	mkdirSync(lockPath, { recursive: false });
	if (malformed === "malformed") {
		writeFileSync(statePath, "{ legacy writer", "utf8");
	}
	process.send?.("ready");
	process.on("message", (message) => {
		if (
			typeof message !== "object" ||
			message === null ||
			message.kind !== "release"
		)
			return;
		if (message.publication !== undefined) {
			writeFileSync(
				statePath,
				`${JSON.stringify(message.publication)}\n`,
				"utf8",
			);
		}
		rmSync(lockPath, { recursive: true, force: true });
		process.send?.("released");
		process.disconnect();
	});
} else if (mode === "observe") {
	const [statePath, rawCount] = args;
	const count = Number(rawCount);
	if (statePath === undefined || !Number.isSafeInteger(count) || count < 1) {
		throw new Error("observe arguments are invalid");
	}
	process.send?.("ready");
	process.on("message", (message) => {
		if (message !== "start") return;
		for (let index = 0; index < count; index += 1) {
			const parsed = JSON.parse(readFileSync(statePath, "utf8"));
			if (
				parsed.version !== 1 ||
				typeof parsed.hooks !== "object" ||
				parsed.hooks === null
			) {
				throw new Error("Observed an incomplete hooks-state snapshot");
			}
		}
		process.send?.("complete");
		process.disconnect();
	});
} else {
	throw new Error(`Unknown child mode: ${mode}`);
}

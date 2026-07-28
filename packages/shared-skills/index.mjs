import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Bundlers inline this module, so import.meta.url points at the consuming bundle.
// dist/index.js sits beside dist/skills, but dist/cli/index.js and dist/cli-node/index.js
// sit one level below it, so the sibling lookup has to fall back to the parent.
export function sharedSkillsRootPath() {
	const sibling = fileURLToPath(new URL("./skills/", import.meta.url));
	if (existsSync(sibling)) return sibling;
	const parent = fileURLToPath(new URL("../skills/", import.meta.url));
	return existsSync(parent) ? parent : sibling;
}

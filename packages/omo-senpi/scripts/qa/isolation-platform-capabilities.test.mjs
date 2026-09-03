import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	scopedIsolationVerdict,
	snapshotDirectory,
} from "./isolation-state.mjs";

const LIMITS = { maxFiles: 10, maxBytes: 1024, maxEntries: 10 };

function codedError(code) {
	return Object.assign(new Error(code), { code });
}

test("#given Darwin Bun rejects Dir first-read on /dev/fd #when descriptor traversal is probed #then the compatible descriptor adapter is used", () => {
	const root = mkdtempSync(join(tmpdir(), "omo-senpi-darwin-descriptor-"));
	try {
		writeFileSync(join(root, "state.json"), "stable");
		const descriptorReads = [];

		const result = snapshotDirectory(root, LIMITS, {
			platform: "darwin",
			readdirSync(path, options) {
				descriptorReads.push(path);
				return readdirSync(path, options);
			},
			opendirSync() {
				return {
					readSync() {
						throw codedError("ENOTDIR");
					},
					closeSync() {},
				};
			},
		});

		expect(result.complete).toBe(true);
		expect(result.errors).toEqual([]);
		expect([...result.snapshot.keys()]).toEqual([".", "state.json"]);
		expect(descriptorReads).toHaveLength(1);
		expect(descriptorReads[0]).toMatch(/^\/dev\/fd\/\d+$/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("#given Windows lacks descriptor-bound directory traversal #when isolation is observed #then capability failure is explicit and cannot certify", () => {
	const root = mkdtempSync(join(tmpdir(), "omo-senpi-windows-descriptor-"));
	try {
		const before = snapshotDirectory(root, LIMITS, { platform: "win32" });
		const after = snapshotDirectory(root, LIMITS, { platform: "win32" });

		expect(before.complete).toBe(false);
		expect(before.errors).toEqual([
			{ path: ".", code: "DIRECTORY_IDENTITY_UNAVAILABLE" },
		]);
		expect(
			scopedIsolationVerdict([{ name: "HOME", before, after }]).certified,
		).toBe(false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

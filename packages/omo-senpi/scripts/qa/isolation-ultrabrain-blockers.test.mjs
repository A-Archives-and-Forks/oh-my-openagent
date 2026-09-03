import { expect, test } from "bun:test";
import {
	mkdtempSync,
	readlinkSync,
	rmSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	changedSnapshotPaths,
	classifyObservedChanges,
	isolationVerdict,
	snapshotDirectory,
} from "./isolation-state.mjs";

const LIMITS = { maxFiles: 10, maxBytes: 1024, maxEntries: 10 };

function completeProtected() {
	return { snapshot: new Map(), complete: true, errors: [] };
}

function completeObserved() {
	return {
		snapshot: new Map(),
		complete: true,
		truncated: false,
		errors: [],
		bytesRead: 0,
	};
}

test("#given an observation I/O error #when the canonical verdict is built #then untouched fails closed", () => {
	// Given
	const protectedState = completeProtected();
	const beforeObserved = completeObserved();
	const afterObserved = {
		...completeObserved(),
		complete: false,
		errors: [{ path: ".", code: "EIO" }],
	};

	// When
	const verdict = isolationVerdict({
		beforeProtected: protectedState,
		afterProtected: protectedState,
		beforeObserved,
		afterObserved,
		observedChangedPaths: [],
	});

	// Then
	expect(verdict.untouched).toBe(false);
});

test("#given a truncated bounded observation #when the canonical verdict is built #then untouched fails closed", () => {
	// Given
	const protectedState = completeProtected();
	const beforeObserved = completeObserved();
	const afterObserved = {
		...completeObserved(),
		complete: false,
		truncated: true,
	};

	// When
	const verdict = isolationVerdict({
		beforeProtected: protectedState,
		afterProtected: protectedState,
		beforeObserved,
		afterObserved,
		observedChangedPaths: [],
	});

	// Then
	expect(verdict.untouched).toBe(false);
});

test("#given a persistent symlink is created and retargeted #when snapshots are compared #then both changes are observed without following targets", () => {
	// Given
	const root = mkdtempSync(join(tmpdir(), "omo-senpi-symlink-change-"));
	const outside = mkdtempSync(join(tmpdir(), "omo-senpi-symlink-target-"));
	const firstTarget = join(outside, "first.txt");
	const secondTarget = join(outside, "second.txt");
	const link = join(root, "persistent-link");
	try {
		writeFileSync(firstTarget, "first-private-content");
		writeFileSync(secondTarget, "second-private-content");
		const before = snapshotDirectory(root, LIMITS);
		symlinkSync(firstTarget, link);
		const created = snapshotDirectory(root, LIMITS);
		unlinkSync(link);
		symlinkSync(secondTarget, link);
		const retargeted = snapshotDirectory(root, LIMITS);

		// When
		const createdPaths = isolationVerdict({
			beforeProtected: completeProtected(),
			afterProtected: completeProtected(),
			beforeObserved: before,
			afterObserved: created,
			observedChangedPaths: changedSnapshotPaths(
				before.snapshot,
				created.snapshot,
			),
		});
		const retargetedDigestChanged =
			created.snapshot.get("persistent-link") !==
			retargeted.snapshot.get("persistent-link");

		// Then
		expect(created.complete).toBe(true);
		expect(createdPaths.changedPaths).toEqual(["persistent-link"]);
		expect(createdPaths.untouched).toBe(false);
		expect(retargetedDigestChanged).toBe(true);
	} finally {
		rmSync(root, { recursive: true, force: true });
		rmSync(outside, { recursive: true, force: true });
	}
});

test("#given a symlink escapes the observation root #when its target contents change #then the link digest stays stable", () => {
	// Given
	const root = mkdtempSync(join(tmpdir(), "omo-senpi-symlink-root-"));
	const outside = mkdtempSync(join(tmpdir(), "omo-senpi-symlink-outside-"));
	const target = join(outside, "private.txt");
	const link = join(root, "outside-link");
	try {
		writeFileSync(target, "before-private-content");
		symlinkSync(target, link);
		const before = snapshotDirectory(root, LIMITS, {
			readlinkSync,
			readFileSync(path) {
				throw new Error(`unexpected target read: ${path}`);
			},
		});

		// When
		writeFileSync(target, "after-private-content");
		const after = snapshotDirectory(root, LIMITS, {
			readlinkSync,
			readFileSync(path) {
				throw new Error(`unexpected target read: ${path}`);
			},
		});

		// Then
		expect(before.complete).toBe(true);
		expect(after.complete).toBe(true);
		expect([...before.snapshot.keys()]).toEqual(["outside-link"]);
		expect(before.snapshot.get("outside-link")).toBe(
			after.snapshot.get("outside-link"),
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
		rmSync(outside, { recursive: true, force: true });
	}
});

test("#given POSIX and Windows path styles #when observed paths are classified #then only the producing style treats backslash as a separator", () => {
	// Given
	const path = "sessions\\persistent.json";

	// When
	const posix = classifyObservedChanges([path], "posix");
	const windows = classifyObservedChanges([path], "windows");

	// Then
	expect(posix.other).toEqual([path]);
	expect(posix.volatile).toEqual([]);
	expect(windows.other).toEqual([]);
	expect(windows.volatile).toEqual(["sessions/persistent.json"]);
});

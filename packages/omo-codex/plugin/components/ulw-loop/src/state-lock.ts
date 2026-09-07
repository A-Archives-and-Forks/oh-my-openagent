import { closeSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { UlwLoopError } from "./types.js";

// Cross-process exclusive lock for one ulw-loop state directory. Every CLI
// invocation is its own process, so the in-process promise chain in plan-io
// serializes nothing across them; this file-level lock is what makes the
// read-modify-write of goals.json (and the counters next to it) atomic.
//
// Protocol: the lock is a file created with O_EXCL whose body records the
// owner. A waiter reclaims it only when the owner is provably gone (pid dead)
// or the record is older than `staleMs` (pid reuse guard); otherwise it backs
// off and fails closed at `timeoutMs` rather than proceeding unlocked.

export const ULW_LOOP_LOCK_TIMEOUT_CODE = "ULW_LOOP_LOCK_TIMEOUT";

export interface StateLockOptions {
	readonly timeoutMs?: number;
	readonly staleMs?: number;
}

interface LockRecord {
	readonly pid: number;
	readonly createdAt: string;
}

interface LockSnapshot {
	readonly raw: string;
	readonly record: LockRecord | null;
	readonly ageMs: number;
}

type AttemptOutcome = "acquired" | "retry" | "wait";

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_STALE_MS = 60_000;
const MIN_DELAY_MS = 5;
const MAX_DELAY_MS = 100;
const SLEEP_CELL = new Int32Array(new SharedArrayBuffer(4));

export async function withStateLock<T>(
	lockPath: string,
	fn: () => Promise<T>,
	options: StateLockOptions = {},
): Promise<T> {
	await acquireAsync(lockPath, options);
	try {
		return await fn();
	} finally {
		release(lockPath);
	}
}

export function withStateLockSync<T>(lockPath: string, fn: () => T, options: StateLockOptions = {}): T {
	acquireSync(lockPath, options);
	try {
		return fn();
	} finally {
		release(lockPath);
	}
}

export function isStateLockTimeout(error: unknown): error is UlwLoopError {
	return error instanceof UlwLoopError && error.code === ULW_LOOP_LOCK_TIMEOUT_CODE;
}

async function acquireAsync(lockPath: string, options: StateLockOptions): Promise<void> {
	const deadline = Date.now() + (options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
	const staleMs = options.staleMs ?? DEFAULT_STALE_MS;
	mkdirSync(dirname(lockPath), { recursive: true });
	for (let attempt = 0; ; ) {
		const outcome = attemptOnce(lockPath, staleMs);
		if (outcome === "acquired") return;
		if (outcome === "retry") continue;
		if (Date.now() >= deadline) throw lockTimeout(lockPath, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
		await sleep(backoffMs(attempt));
		attempt += 1;
	}
}

function acquireSync(lockPath: string, options: StateLockOptions): void {
	const deadline = Date.now() + (options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
	const staleMs = options.staleMs ?? DEFAULT_STALE_MS;
	mkdirSync(dirname(lockPath), { recursive: true });
	for (let attempt = 0; ; ) {
		const outcome = attemptOnce(lockPath, staleMs);
		if (outcome === "acquired") return;
		if (outcome === "retry") continue;
		if (Date.now() >= deadline) throw lockTimeout(lockPath, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
		Atomics.wait(SLEEP_CELL, 0, 0, backoffMs(attempt));
		attempt += 1;
	}
}

// EINTR surfaces raw from macOS fs syscalls under some runtimes; it is a retry, never a verdict.
function attemptOnce(lockPath: string, staleMs: number): AttemptOutcome {
	try {
		if (tryCreate(lockPath)) return "acquired";
		const snapshot = readSnapshot(lockPath);
		if (snapshot === null) return "retry";
		if (isStale(snapshot, staleMs) && reclaim(lockPath, snapshot.raw)) return "retry";
		return "wait";
	} catch (error) {
		if (hasCode(error, "EINTR")) return "wait";
		throw error;
	}
}

function tryCreate(lockPath: string): boolean {
	let fd: number;
	try {
		fd = openSync(lockPath, "wx");
	} catch (error) {
		if (hasCode(error, "EEXIST")) return false;
		throw error;
	}
	try {
		const record: LockRecord = { pid: process.pid, createdAt: new Date().toISOString() };
		writeSync(fd, JSON.stringify(record));
	} finally {
		closeSync(fd);
	}
	return true;
}

function readSnapshot(lockPath: string): LockSnapshot | null {
	try {
		const raw = readFileSync(lockPath, "utf8");
		const ageMs = Date.now() - statSync(lockPath).mtimeMs;
		return { raw, record: parseRecord(raw), ageMs };
	} catch (error) {
		if (hasCode(error, "ENOENT")) return null;
		throw error;
	}
}

function parseRecord(raw: string): LockRecord | null {
	try {
		const parsed: unknown = JSON.parse(raw);
		if (typeof parsed !== "object" || parsed === null) return null;
		const record = parsed as Record<string, unknown>;
		const pid = record["pid"];
		const createdAt = record["createdAt"];
		if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0 || typeof createdAt !== "string") return null;
		return { pid, createdAt };
	} catch (error) {
		if (error instanceof SyntaxError) return null;
		throw error;
	}
}

// A young record without an owner pid is a lock mid-write; only age retires it.
function isStale(snapshot: LockSnapshot, staleMs: number): boolean {
	if (snapshot.ageMs > staleMs) return true;
	if (snapshot.record === null) return false;
	return !isProcessAlive(snapshot.record.pid);
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		if (hasCode(error, "ESRCH")) return false;
		if (hasCode(error, "EPERM")) return true;
		throw error;
	}
}

// Re-read right before unlinking so a lock that changed hands since the stale
// verdict (a sibling waiter reclaimed and re-acquired it) is left alone.
function reclaim(lockPath: string, expectedRaw: string): boolean {
	const current = readSnapshot(lockPath);
	if (current === null) return true;
	if (current.raw !== expectedRaw) return false;
	try {
		unlinkSync(lockPath);
	} catch (error) {
		if (!hasCode(error, "ENOENT")) throw error;
	}
	return true;
}

function release(lockPath: string): void {
	try {
		unlinkSync(lockPath);
	} catch (error) {
		if (!hasCode(error, "ENOENT")) throw error;
	}
}

function backoffMs(attempt: number): number {
	const exponential = Math.min(MAX_DELAY_MS, MIN_DELAY_MS * 2 ** attempt);
	return exponential + Math.random() * MIN_DELAY_MS;
}

function lockTimeout(lockPath: string, timeoutMs: number): UlwLoopError {
	const holder = readSnapshot(lockPath)?.record;
	const owner = holder === undefined || holder === null ? "another process" : `pid ${holder.pid}`;
	return new UlwLoopError(
		`ulw-loop state lock ${lockPath} is held by ${owner} for more than ${timeoutMs}ms; retry once that process finishes, or delete the lock file if that process is gone.`,
		ULW_LOOP_LOCK_TIMEOUT_CODE,
		{
			details: {
				lockPath,
				timeoutMs,
				...(holder === undefined || holder === null ? {} : { holderPid: holder.pid }),
			},
		},
	);
}

function hasCode(error: unknown, code: string): boolean {
	return error instanceof Error && "code" in error && error.code === code;
}

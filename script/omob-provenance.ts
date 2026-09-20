import { readFileSync, statSync, writeFileSync } from "node:fs"

export interface BinaryIdentity {
	readonly dev: number
	readonly ino: number
	readonly size: number
	readonly mtimeMs: number
	/** Included so a chmod alone stops the marker from speaking for the file. */
	readonly mode: number
}

export interface ProvenanceMarker {
	readonly identity: BinaryIdentity
	readonly versionOutput: string
}

export function provenancePath(binary: string): string {
	return `${binary}.provenance.json`
}

export function binaryIdentity(binary: string): BinaryIdentity | undefined {
	try {
		const stats = statSync(binary)
		return { dev: stats.dev, ino: stats.ino, size: stats.size, mtimeMs: stats.mtimeMs, mode: stats.mode }
	} catch {
		return undefined
	}
}

const IDENTITY_FIELDS = ["dev", "ino", "size", "mtimeMs", "mode"] as const

function isBinaryIdentity(value: unknown): value is BinaryIdentity {
	if (typeof value !== "object" || value === null) return false
	const record = value as Record<string, unknown>
	return IDENTITY_FIELDS.every((field) => typeof record[field] === "number")
}

function sameIdentity(left: BinaryIdentity, right: BinaryIdentity): boolean {
	return IDENTITY_FIELDS.every((field) => left[field] === right[field])
}

/**
 * Records what an installed executable answers to `--version`, so the refresh check does not
 * have to spawn it on every launch. The marker is bound to the exact file it was written for:
 * `installBinary` publishes through `renameSync`, which always yields a fresh inode, so a
 * marker left behind by a failed or partial install can never be mistaken for the executable
 * that is actually on disk.
 */
export function writeProvenanceMarker(binary: string, versionOutput: string): void {
	const identity = binaryIdentity(binary)
	if (identity === undefined) return
	try {
		writeFileSync(provenancePath(binary), `${JSON.stringify({ identity, versionOutput })}\n`)
	} catch {
		// The marker is a cache; failing to write it only costs the next launch a spawn.
	}
}

export function readProvenanceMarker(binary: string): string | undefined {
	const identity = binaryIdentity(binary)
	if (identity === undefined) return undefined
	let parsed: unknown
	try {
		parsed = JSON.parse(readFileSync(provenancePath(binary), "utf8"))
	} catch {
		return undefined
	}
	// Anything can be on disk here - a truncated write, a hand-edit, a file from another tool - and
	// every shape must degrade to "ask the executable", never to a throw on the launch path.
	if (typeof parsed !== "object" || parsed === null) return undefined
	const record = parsed as Record<string, unknown>
	if (typeof record.versionOutput !== "string") return undefined
	if (!isBinaryIdentity(record.identity)) return undefined
	return sameIdentity(record.identity, identity) ? record.versionOutput : undefined
}

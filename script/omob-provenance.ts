import { readFileSync, statSync, writeFileSync } from "node:fs"

export interface BinaryIdentity {
	readonly dev: number
	readonly ino: number
	readonly size: number
	readonly mtimeMs: number
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
		return { dev: stats.dev, ino: stats.ino, size: stats.size, mtimeMs: stats.mtimeMs }
	} catch {
		return undefined
	}
}

function sameIdentity(left: BinaryIdentity, right: BinaryIdentity): boolean {
	return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeMs === right.mtimeMs
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
	let parsed: Partial<ProvenanceMarker>
	try {
		parsed = JSON.parse(readFileSync(provenancePath(binary), "utf8")) as Partial<ProvenanceMarker>
	} catch {
		return undefined
	}
	const recorded = parsed.identity
	if (recorded === undefined || typeof parsed.versionOutput !== "string") return undefined
	if (typeof recorded.dev !== "number" || typeof recorded.ino !== "number") return undefined
	if (typeof recorded.size !== "number" || typeof recorded.mtimeMs !== "number") return undefined
	return sameIdentity(recorded, identity) ? parsed.versionOutput : undefined
}

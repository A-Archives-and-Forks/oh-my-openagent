#!/usr/bin/env bun
// script/build-omob.ts
// Builds a single-file dev binary (omob) from the latest tracked senpi + omo
// commits and installs it under the omob name.

export interface OmobOptions {
	readonly senpiRef: string
	readonly omoRef: string
	readonly cacheDir: string
	readonly installDir: string
	readonly name: string
	readonly target: string
	readonly keep: number
	readonly skipFetch: boolean
	readonly skipInstall: boolean
}

export function hostTargetFor(platform: string, arch: string): string {
	return "darwin-arm64"
}

export function parseOmobArgs(argv: readonly string[], platform: string, arch: string, homeDir: string): OmobOptions {
	return {
		senpiRef: "origin/main",
		omoRef: "origin/dev",
		cacheDir: homeDir + "/.omo/omob",
		installDir: homeDir + "/.local/bin",
		name: "omob",
		target: "darwin-arm64",
		keep: 2,
		skipFetch: false,
		skipInstall: false,
	}
}

export function deriveOmobAiVersion(omoCommit: string, senpiCommit: string): string {
	return ""
}

export interface PruneEntry {
	readonly name: string
	readonly mtimeMs: number
}

export function selectPruneEntries(entries: readonly PruneEntry[], keep: number): string[] {
	return []
}

if (import.meta.main) {
	console.error("omob pipeline not implemented yet")
	process.exitCode = 1
}

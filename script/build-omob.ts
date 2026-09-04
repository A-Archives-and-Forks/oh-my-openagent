#!/usr/bin/env bun
// script/build-omob.ts
// Builds a single-file dev binary ("omob") from the latest tracked senpi (origin/main)
// and omo (origin/dev) commits and installs it under the omob name. Dev builds share
// ~/.omo state with a regular omo installation; only the binary and its provisioned
// runtime dir are namespaced by the commit pair.

import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, chmodSync, renameSync, cpSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { parseBuildInfo, type OmoBuildInfo } from "../packages/omo-native/build-info"
import { RELEASE_BINARY_TARGETS, buildReleaseBinary } from "./build-omo-binary"

const scriptDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(scriptDir, "..")

export interface OmobOptions {
	readonly senpiRef: string
	readonly omoRef: string
	readonly cacheDir: string
	readonly installDir: string
	readonly name: string
	readonly target: string
	readonly keep: number
	readonly senpiUrl: string
	readonly skipFetch: boolean
	readonly skipInstall: boolean
}

export function hostTargetFor(platform: string, arch: string): string {
	if (platform === "darwin") return arch === "arm64" ? "darwin-arm64" : "darwin-x64"
	if (platform === "linux") return arch === "arm64" ? "linux-arm64" : "linux-x64"
	if (platform === "win32") return "windows-x64"
	throw new Error(`unsupported host platform: ${platform} ${arch}`)
}

const DEFAULT_SENPI_URL = "https://github.com/code-yeongyu/senpi.git"

export function parseOmobArgs(argv: readonly string[], platform: string, arch: string, homeDir: string): OmobOptions {
	const options: { senpiRef?: string; omoRef?: string; cacheDir?: string; installDir?: string; name?: string; target?: string; senpiUrl?: string; keep?: number; skipFetch: boolean; skipInstall: boolean } = {
		senpiUrl: undefined,
		skipFetch: false,
		skipInstall: false,
	}
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index]
		const value = argv[index + 1]
		if (argument === "--senpi-ref" || argument === "--omo-ref" || argument === "--cache-dir" || argument === "--install-dir" || argument === "--name" || argument === "--target" || argument === "--senpi-url") {
			if (value === undefined) throw new Error(`${argument} requires a value`)
			const key = argument.slice(2).replaceAll("-", "") as "senpiRef" | "omoRef" | "cacheDir" | "installDir" | "name" | "target"
			const normalizedKey = argument === "--senpi-ref" ? "senpiRef" : argument === "--omo-ref" ? "omoRef" : argument === "--cache-dir" ? "cacheDir" : argument === "--install-dir" ? "installDir" : argument === "--name" ? "name" : argument === "--senpi-url" ? "senpiUrl" : "target"
			;(options as Record<string, unknown>)[normalizedKey] = value
			index += 1
		} else if (argument === "--keep") {
			if (value === undefined) throw new Error("--keep requires a value")
			const keep = Number.parseInt(value, 10)
			if (!Number.isInteger(keep) || keep < 0) throw new Error("--keep must be a non-negative integer")
			options.keep = keep
			index += 1
		} else if (argument === "--skip-fetch") {
			options.skipFetch = true
		} else if (argument === "--skip-install") {
			options.skipInstall = true
		} else {
			throw new Error(`unknown argument: ${argument}`)
		}
	}
	return {
		senpiRef: options.senpiRef ?? "origin/main",
		omoRef: options.omoRef ?? "origin/dev",
		cacheDir: options.cacheDir ?? join(homeDir, ".omo", "omob"),
		installDir: options.installDir ?? join(homeDir, ".local", "bin"),
		name: options.name ?? "omob",
		target: options.target ?? hostTargetFor(platform, arch),
		keep: options.keep ?? 2,
		senpiUrl: options.senpiUrl ?? DEFAULT_SENPI_URL,
		skipFetch: options.skipFetch,
		skipInstall: options.skipInstall,
	}
}

export function deriveOmobAiVersion(omoCommit: string, senpiCommit: string): string {
	return `0.0.0-omob.${omoCommit.slice(0, 7)}.${senpiCommit.slice(0, 7)}`
}

export interface PruneEntry {
	readonly name: string
	readonly mtimeMs: number
}

const OMOB_RUNTIME_PREFIX = "0.0.0-omob."

export function isOmobRuntimeDir(name: string): boolean {
	return name.startsWith(OMOB_RUNTIME_PREFIX)
}

/** Names of dev runtime dirs to delete: omob dirs beyond the newest `keep`. Release runtimes are never touched. */
export function selectPruneEntries(entries: readonly PruneEntry[], keep: number): string[] {
	const omob = entries.filter((entry) => isOmobRuntimeDir(entry.name))
	const sorted = omob.slice().sort((left, right) => right.mtimeMs - left.mtimeMs)
	return sorted.slice(Math.max(0, keep)).reverse().map((entry) => entry.name)
}

function run(command: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv = process.env): void {
	const result = spawnSync(command, [...args], { cwd, stdio: "inherit", env })
	if (result.error !== undefined) throw result.error
	if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status ?? 1}`)
}

function runCaptured(command: string, args: readonly string[], cwd: string): string {
	const result = spawnSync(command, [...args], { cwd, encoding: "utf8" })
	if (result.error !== undefined) throw result.error
	if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status ?? 1}:\n${result.stdout}\n${result.stderr}`)
	return result.stdout.trim()
}

function ensureCacheClone(url: string, directory: string, ref: string, skipFetch: boolean): { readonly directory: string; readonly commit: string } {
	mkdirSync(dirname(directory), { recursive: true })
	if (!existsSync(join(directory, ".git"))) {
		run("git", ["clone", "--filter=blob:none", url, directory], dirname(directory))
	}
	if (!skipFetch) {
		// Branch refs fetch a single refspec; raw SHAs need the whole history.
		const fetchArgs = ref.startsWith("origin/") ? ["--prune", "origin", ref.slice("origin/".length)] : ["--prune", "origin"]
		run("git", ["fetch", ...fetchArgs], directory)
	}
	run("git", ["checkout", "--force", ref], directory)
	run("git", ["reset", "--hard", ref], directory)
	const commit = runCaptured("git", ["rev-parse", "HEAD"], directory)
	return { directory, commit }
}

interface CommitInfo {
	readonly commit: string
	readonly committedAt: string
	readonly branch: string
}

function readCommitInfo(directory: string, ref: string): CommitInfo {
	const commit = runCaptured("git", ["rev-parse", "HEAD"], directory)
	const committedAt = runCaptured("git", ["log", "-1", "--format=%cI"], directory)
	const rawBranch = runCaptured("git", ["rev-parse", "--abbrev-ref", ref], directory).trim()
	const branch = rawBranch === "HEAD" || rawBranch === "" ? ref.replace(/^origin\//, "") : rawBranch
	return { commit, committedAt, branch }
}

function buildSenpiPackage(senpiDir: string, cacheDir: string, ref: string): string {
	run("bun", ["install"], senpiDir)
	run("bun", ["run", "build:bun"], senpiDir)
	// Stage the bundled workspaces exactly like the release pipeline, then pack.
	run("node", [join("scripts", "prepare-senpi-bundled-workspaces.mjs")], senpiDir)
	const tarballDir = join(cacheDir, "tarballs")
	mkdirSync(tarballDir, { recursive: true })
	run("bun", ["pm", "pack", "--destination", tarballDir], join(senpiDir, "packages", "coding-agent"))
	const tarballName = readdirSync(tarballDir).find((name) => name.endsWith(".tgz"))
	if (tarballName === undefined) throw new Error("bun pm pack produced no senpi tarball")
	// Isolated production install: the tarball plus its registry deps, resolved under
	// a dedicated root so the resulting tree can be dropped into omo's node_modules.
	const installRoot = join(cacheDir, "senpi-install")
	rmSync(installRoot, { recursive: true, force: true })
	mkdirSync(installRoot, { recursive: true })
	writeFileSync(join(installRoot, "package.json"), `${JSON.stringify({ private: true, dependencies: { "@code-yeongyu/senpi": `file:../tarballs/${tarballName}` } }, undefined, "\t")}\n`)
	run("bun", ["install", "--production", "--ignore-scripts"], installRoot)
	nestHoistedDeps(installRoot)
	return join(installRoot, "node_modules", "@code-yeongyu", "senpi")
}

/** Moves the isolated install's hoisted deps under the senpi package, mirroring the published nested layout. */
function nestHoistedDeps(installRoot: string): void {
	const senpiNodeModules = join(installRoot, "node_modules", "@code-yeongyu", "senpi", "node_modules")
	const topLevel = join(installRoot, "node_modules")
	mkdirSync(senpiNodeModules, { recursive: true })
	for (const entry of readdirSync(topLevel)) {
		if (entry.startsWith(".") || entry === "@code-yeongyu") continue
		const from = join(topLevel, entry)
		const to = join(senpiNodeModules, entry)
		if (existsSync(to)) continue
		renameSync(from, to)
	}
}

function swapSenpi(omoDir: string, builtSenpiRoot: string): void {
	const target = join(omoDir, "node_modules", "@code-yeongyu", "senpi")
	if (existsSync(target)) rmSync(target, { recursive: true, force: true })
	mkdirSync(dirname(target), { recursive: true })
	cpSync(builtSenpiRoot, target, { recursive: true })
	// Re-apply the launcher's claude-code version floor patch on the swapped engine.
	run("bun", [join("packages", "omo-native", "bin", "senpi-patch.mjs")], omoDir, { ...process.env, OMO_SENPI_PATCH_ROOT: target })
}

function pruneOmobRuntimes(keep: number): void {
	const runtimeRoot = join(homedir(), ".omo", "binary-runtime")
	if (!existsSync(runtimeRoot)) return
	const entries: PruneEntry[] = readdirSync(runtimeRoot).map((name) => {
		const stats = statSync(join(runtimeRoot, name))
		return { name, mtimeMs: stats.mtimeMs }
	})
	for (const name of selectPruneEntries(entries, keep)) {
		rmSync(join(runtimeRoot, name), { recursive: true, force: true })
		console.log(`pruned dev runtime ${name}`)
	}
}

function installBinary(binaryPath: string, installDir: string, name: string): string {
	mkdirSync(installDir, { recursive: true })
	const destination = join(installDir, name)
	const temporary = `${destination}.tmp-${process.pid}`
	rmSync(temporary, { force: true })
	cpSync(binaryPath, temporary)
	chmodSync(temporary, 0o755)
	renameSync(temporary, destination)
	return destination
}

async function main(argv: readonly string[]): Promise<number> {
	const options = parseOmobArgs(argv, process.platform, process.arch, homedir())
const senpiUrl = options.senpiUrl ?? DEFAULT_SENPI_URL
	const senpi = ensureCacheClone(senpiUrl, join(options.cacheDir, "senpi"), options.senpiRef, options.skipFetch)
	const omo = ensureCacheClone(runCaptured("git", ["remote", "get-url", "origin"], repoRoot), join(options.cacheDir, "omo"), options.omoRef, options.skipFetch)

	const senpiInfo = readCommitInfo(senpi.directory, options.senpiRef)
	const omoInfo = readCommitInfo(omo.directory, options.omoRef)
	const buildInfo: OmoBuildInfo = {
		command: options.name,
		omo: omoInfo,
		engine: { commit: senpiInfo.commit, committedAt: senpiInfo.committedAt, branch: senpiInfo.branch },
	}

	const builtSenpiRoot = buildSenpiPackage(senpi.directory, options.cacheDir, options.senpiRef)
	run("bun", ["install"], omo.directory)
	swapSenpi(omo.directory, builtSenpiRoot)

	const target = RELEASE_BINARY_TARGETS.find((entry) => entry.target === options.target)
	if (target === undefined) throw new Error(`unknown target: ${options.target}`)
	const omoAiVersion = deriveOmobAiVersion(omoInfo.commit, senpiInfo.commit)
	const result = await buildReleaseBinary(target, {
		omoVersion: omoAiVersion,
		omoAiVersion,
		outDir: join(options.cacheDir, "out"),
		buildInfo,
	})

	if (!options.skipInstall) {
		const installed = installBinary(result.binaryPath, options.installDir, options.name)
		console.log(`installed ${installed} (${result.size} bytes)`)
	}
	pruneOmobRuntimes(options.keep)
	const lines = [buildInfo.command + " dev build", `omo   ${omoInfo.commit} ${omoInfo.committedAt} (${omoInfo.branch})`, `senpi ${senpiInfo.commit} ${senpiInfo.committedAt} (${senpiInfo.branch})`]
	console.log(lines.join("\n"))
	return 0
}

if (import.meta.main) {
	try {
		process.exit(await main(process.argv.slice(2)))
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error))
		process.exit(1)
	}
}

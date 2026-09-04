// Contract tests for script/build-omob.ts.

import { describe, expect, test } from "bun:test"
import { deriveOmobAiVersion, hostTargetFor, parseOmobArgs, selectPruneEntries } from "./build-omob"

describe("parseOmobArgs", () => {
	test("defaults to the latest tracked refs and the host target", () => {
		const parsed = parseOmobArgs([], "darwin", "arm64", "/home/dev")
		expect(parsed.senpiRef).toBe("origin/main")
		expect(parsed.omoRef).toBe("origin/dev")
		expect(parsed.name).toBe("omob")
		expect(parsed.keep).toBe(2)
		expect(parsed.target).toBe("darwin-arm64")
		expect(parsed.installDir).toBe("/home/dev/.local/bin")
		expect(parsed.cacheDir).toBe("/home/dev/.omo/omob")
		expect(parsed.skipFetch).toBe(false)
		expect(parsed.skipInstall).toBe(false)
	})

	test("accepts ref overrides and keep counts", () => {
		const parsed = parseOmobArgs(
			["--senpi-ref", "origin/feat/x", "--omo-ref", "abc1234", "--keep", "5", "--skip-fetch", "--skip-install"],
			"linux",
			"x64",
			"/home/dev",
		)
		expect(parsed.senpiRef).toBe("origin/feat/x")
		expect(parsed.omoRef).toBe("abc1234")
		expect(parsed.keep).toBe(5)
		expect(parsed.skipFetch).toBe(true)
		expect(parsed.skipInstall).toBe(true)
		expect(parsed.target).toBe("linux-x64")
	})

	test("rejects unknown flags", () => {
		expect(() => parseOmobArgs(["--nonsense"], "darwin", "arm64", "/home/dev")).toThrow()
	})

	test("maps host platforms onto release targets", () => {
		expect(hostTargetFor("darwin", "arm64")).toBe("darwin-arm64")
		expect(hostTargetFor("darwin", "x64")).toBe("darwin-x64")
		expect(hostTargetFor("linux", "arm64")).toBe("linux-arm64")
		expect(hostTargetFor("linux", "x64")).toBe("linux-x64")
		expect(hostTargetFor("win32", "x64")).toBe("windows-x64")
	})
})

describe("deriveOmobAiVersion", () => {
	test("embeds both short shas in the dev version", () => {
		expect(deriveOmobAiVersion("c6e7dd7fb0f993336ed61c62acc5d55c6ada8bfc", "7fd18dfeec7a7db89a983b2c3cb90835b8c3c5f7")).toBe(
			"0.0.0-omob.c6e7dd7.7fd18df",
		)
	})
})

describe("selectPruneEntries", () => {
	const entries = [
		{ name: "0.0.0-omob.aaaaaaa.bbbbbbb", mtimeMs: 3 },
		{ name: "0.0.0-omob.ccccccc.ddddddd", mtimeMs: 1 },
		{ name: "0.0.0-omob.eeeeeee.fffffff", mtimeMs: 2 },
		{ name: "5.0.0-0.beta.39", mtimeMs: 0 },
		{ name: "0.0.0-omob.1111111.2222222", mtimeMs: 5 },
	]

	test("keeps the newest dev runtimes and never touches release runtimes", () => {
		expect(selectPruneEntries(entries, 2)).toEqual(["0.0.0-omob.ccccccc.ddddddd", "0.0.0-omob.eeeeeee.fffffff"])
	})

	test("keeps everything below the budget", () => {
		expect(selectPruneEntries(entries, 3)).toEqual(["0.0.0-omob.ccccccc.ddddddd"])
		expect(selectPruneEntries(entries, 4)).toEqual([])
	})
})

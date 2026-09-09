import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { installOmobLauncher, parseOmobArgs } from "./build-omob"

const builder = resolve(import.meta.dir, "build-omob.ts")
const canonical = "https://github.com/code-yeongyu/oh-my-openagent.git"

// Replace only the expensive package/compiler boundary. Git, cache selection,
// update decisions, installs and the installed launcher all run the real code.
const compiler = `#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process');
const args = process.argv.slice(2), cwd = process.cwd();
if (args[0]?.endsWith('/script/build-omob.ts')) {
 const result = cp.spawnSync(process.env.OMOB_TEST_BUN, [process.env.OMOB_TEST_BUILDER, ...args.slice(1)], {stdio:'inherit'});
 process.exit(result.status ?? 1);
}
if (args.includes('script/build-omo-binary.ts')) {
 fs.appendFileSync(process.env.OMOB_TEST_BUILDS, 'compile\\n');
 if (process.env.OMOB_TEST_FAIL === '1') process.exit(23);
 const info = JSON.parse(args[args.indexOf('--build-info')+1]);
 const version = [info.command+' dev build', 'omo   '+info.omo.commit+' '+info.omo.committedAt+' ('+info.omo.branch+')', 'senpi '+info.engine.commit+' '+info.engine.committedAt+' ('+info.engine.branch+')'].join('\\n');
 const out = args[args.indexOf('--out-dir')+1], target = args[args.indexOf('--target')+1];
 fs.mkdirSync(out,{recursive:true});
 fs.writeFileSync(path.join(out,'omo-'+target), '#!/usr/bin/env node\\nif(process.argv[2]==="--version") console.log('+JSON.stringify(version)+'); else {console.log(JSON.stringify(process.argv.slice(2))); process.exit(17)}\\n', {mode:0o755});
} else if (args[0] === 'pm') {
 fs.writeFileSync(path.join(args[args.indexOf('--destination')+1],'senpi.tgz'),'fixture');
} else if (args[0] === 'install') {
 fs.mkdirSync(path.join(cwd,'node_modules'),{recursive:true});
 if (path.basename(cwd)==='senpi-install') {
  const pkg=path.join(cwd,'node_modules/@code-yeongyu/senpi');
  fs.mkdirSync(pkg,{recursive:true}); fs.writeFileSync(path.join(pkg,'package.json'),'{}');
 }
}
`

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "omob-refresh-"))
	const omo = join(root, "upstream-omo"), senpi = join(root, "upstream-senpi")
	const cache = join(root, "cache"), tools = join(root, "tools"), builds = join(root, "builds")
	const env = { ...process.env, PATH: `${tools}:${process.env.PATH}`, OMOB_TEST_BUN: process.execPath, OMOB_TEST_BUILDER: builder, OMOB_TEST_BUILDS: builds,
		GIT_CONFIG_COUNT: "5", GIT_CONFIG_KEY_0: "user.name", GIT_CONFIG_VALUE_0: "Test", GIT_CONFIG_KEY_1: "user.email", GIT_CONFIG_VALUE_1: "test@example.com",
		GIT_CONFIG_KEY_2: `url.file://${omo}.insteadOf`, GIT_CONFIG_VALUE_2: canonical, GIT_CONFIG_KEY_3: "protocol.file.allow", GIT_CONFIG_VALUE_3: "always", GIT_CONFIG_KEY_4: `url.file://${senpi}.insteadOf`, GIT_CONFIG_VALUE_4: "https://github.com/code-yeongyu/senpi.git" }
	const git = (cwd: string, args: string[]) => {
		const result = spawnSync("git", args, { cwd, env, encoding: "utf8" })
		if (result.status !== 0) throw new Error(result.stderr)
		return result.stdout.trim()
	}
	for (const [repo, branch] of [[omo, "dev"], [senpi, "main"]]) {
		mkdirSync(join(repo, "scripts"), { recursive: true })
		mkdirSync(join(repo, "packages", "coding-agent"), { recursive: true })
		writeFileSync(join(repo, "packages", "coding-agent", "package.json"), '{}')
		writeFileSync(join(repo, "package-lock.json"), '{"packages":{}}')
		writeFileSync(join(repo, "scripts", "prepare-senpi-bundled-workspaces.mjs"), "")
		git(repo, ["init", "-q", "-b", branch])
		git(repo, ["add", "."])
		git(repo, ["commit", "-qm", "initial"])
	}
	mkdirSync(cache)
	git(root, ["clone", "-q", canonical, join(cache, "omo")])
	git(omo, ["switch", "-qc", "feature"])
	writeFileSync(join(omo, "uncommitted"), "keep me")
	mkdirSync(tools)
	writeFileSync(join(tools, "bun"), compiler, { mode: 0o755 })
	writeFileSync(builds, "")
	const options = parseOmobArgs(["--cache-dir", cache, "--install-dir", join(root, "install")], process.platform, process.arch, root)
	const args = [builder, "--if-changed", "--binary-only", "--cache-dir", cache, "--install-dir", join(cache, "bin")]
	const run = (extraEnv = {}) => spawnSync(process.execPath, args, { env: { ...env, ...extraEnv }, encoding: "utf8", timeout: 30_000 })
	const ordinary = () => spawnSync(process.execPath, [builder, "--cache-dir", cache, "--install-dir", options.installDir], { env, encoding: "utf8", timeout: 30_000 })
	return { root, omo, senpi, cache, builds, env, options, git, run, ordinary, binary: join(cache, "bin", "omob") }
}

// The launcher is a POSIX shell script, disabled by default on win32 by parseOmobArgs.
describe.skipIf(process.platform === "win32")("omob refresh integration", () => {
	test("#given an ordinary managed install #when ordinary install repeats #then auto-refresh remains installed", () => {
		const f = fixture()
		try {
			const first = f.ordinary()
			expect({ status: first.status, error: first.stderr }).toMatchObject({ status: 0 })
			const repeated = f.ordinary()
			expect({ status: repeated.status, error: repeated.stderr }).toMatchObject({ status: 0 })
			expect(readFileSync(join(f.options.installDir, "omob"), "utf8").split("\n")[0]).toBe("#!/bin/sh")
			expect(readFileSync(f.builds, "utf8")).toBe("compile\n")
		} finally { rmSync(f.root, { recursive: true, force: true }) }
	}, 60_000)

	for (const scenario of ["same", "changed", "failure", "network", "feature", "locked"] as const) {
		test(`#given an installed build #when ${scenario} refresh runs #then only the authoritative pair can launch`, () => {
			const f = fixture()
			try {
				const first = f.run()
				expect({ status: first.status, error: first.stderr }).toMatchObject({ status: 0 })
				const previous = readFileSync(f.binary)
				if (scenario === "changed" || scenario === "failure") {
					writeFileSync(join(f.senpi, "new-commit"), "new")
					f.git(f.senpi, ["add", "."])
					f.git(f.senpi, ["commit", "-qm", "advance"])
				}
				if (scenario === "network") rmSync(f.senpi, { recursive: true, force: true })
				if (scenario === "locked") writeFileSync(join(f.cache, ".lock"), `${process.pid}\n`)
				installOmobLauncher(f.options)
				const result = spawnSync(join(f.options.installDir, "omob"), ["a b", "", "--flag"], { encoding: "utf8", timeout: 30_000, env: { ...f.env, OMOB_TEST_FAIL: scenario === "failure" ? "1" : "0" } })
				if (scenario === "failure" || scenario === "network" || scenario === "locked") {
					expect(result.status).not.toBe(0)
					expect(result.stdout).toBe("")
					expect(readFileSync(f.binary)).toEqual(previous)
				} else {
					expect({ status: result.status, error: result.stderr }).toMatchObject({ status: 17 })
					expect(JSON.parse(result.stdout)).toEqual(["a b", "", "--flag"])
					expect(readFileSync(f.builds, "utf8")).toBe(scenario === "changed" ? "compile\ncompile\n" : "compile\n")
					const version = spawnSync(f.binary, ["--version"], { encoding: "utf8" })
					expect(version.stdout).toContain(f.git(f.senpi, ["rev-parse", "main"]))
				}
				expect(f.git(f.omo, ["branch", "--show-current"])).toBe("feature")
				expect(readFileSync(join(f.omo, "uncommitted"), "utf8")).toBe("keep me")
			} finally { rmSync(f.root, { recursive: true, force: true }) }
		}, 60_000)
	}
})

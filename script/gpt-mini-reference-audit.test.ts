import { describe, expect, test } from "bun:test"
import { readFile, stat } from "node:fs/promises"

const REPOSITORY_ROOT = new URL("../", import.meta.url).pathname
const OLD_MODEL_ID = ["gpt-5.4", "mini"].join("-")
const OLD_DISPLAY_NAME = ["GPT 5.4", "Mini"].join(" ")

describe("GPT Mini reference audit", () => {
  test("tracked shipped files no longer reference the retired GPT Mini model", async () => {
    // given
    const files = await trackedFiles()

    // when
    const matches: string[] = []
    for (const file of files) {
      const path = `${REPOSITORY_ROOT}${file}`
      if (!(await stat(path)).isFile()) continue
      const content = await readFile(path, "utf8")
      if (content.toLowerCase().includes(OLD_MODEL_ID) || content.includes(OLD_DISPLAY_NAME)) {
        matches.push(file)
      }
    }

    // then
    expect(matches).toEqual([])
  })
})

async function trackedFiles(): Promise<string[]> {
  const process = Bun.spawn(["git", "ls-files", "-z"], {
    cwd: REPOSITORY_ROOT,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ])
  if (exitCode !== 0) {
    throw new Error(`git ls-files failed: ${stderr.trim()}`)
  }
  return stdout.split("\0").filter((file) => file.length > 0 && !file.startsWith(".omo/evidence/"))
}

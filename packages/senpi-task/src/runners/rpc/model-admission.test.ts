import { type ChildProcess } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, test } from "bun:test"

import { RunnerError } from "../in-process/runner-error"
import { RpcProcessRunner } from "../rpc-process"
import { spawnFakeChild } from "./__fixtures__/spawn-fake"
import { parseModelCatalog } from "./model-admission"
import type { RpcSpawnDescriptor } from "./spawn"

const children: ChildProcess[] = []
const stateDirs: string[] = []

function makeSpec(model: string) {
  const stateDir = mkdtempSync(join(tmpdir(), "senpi-task-model-admission-"))
  stateDirs.push(stateDir)
  return {
    task_id: "st_model_admission",
    cwd: process.cwd(),
    state_dir: stateDir,
    prompt: "hello",
    model,
  }
}

afterEach(async () => {
  await Promise.all(children.splice(0).map((child) => new Promise<void>((resolve) => {
    child.once("exit", () => resolve())
    child.kill()
  })))
  for (const stateDir of stateDirs.splice(0)) {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

describe("RpcProcessRunner model admission", () => {
  test("#given a Senpi model table #when parsed #then provider and model columns form exact identities", () => {
    // given
    const output = [
      "fixture  visible       128K  8K  yes  no",
      "fixture  visible-fast  128K  8K  yes  no",
      "other    visible       128K  8K  yes  no",
    ].join("\n")

    // when
    const catalog = parseModelCatalog(output)

    // then
    expect(catalog.has("fixture/visible")).toBe(true)
    expect(catalog.has("fixture/vis")).toBe(false)
    expect(catalog.has("other/visible")).toBe(true)
  })

  test("#given a model absent from the child profile #when started #then admission rejects before spawn", async () => {
    // given
    let admissionCalls = 0
    let spawnCalls = 0
    const options = {
      modelAdmission: async () => {
        admissionCalls += 1
        throw new RunnerError({
          kind: "model_unavailable",
          message: "model fixture/missing is not visible to the process child",
        })
      },
      spawnChild: (descriptor: RpcSpawnDescriptor) => {
        spawnCalls += 1
        const child = spawnFakeChild(descriptor.env)
        children.push(child)
        return child
      },
    }
    const runner = new RpcProcessRunner(options)

    // when
    const start = Promise.resolve().then(() => runner.start(makeSpec("fixture/missing")))

    // then
    await expect(start).rejects.toMatchObject({ failure: { kind: "model_unavailable" } })
    expect(admissionCalls).toBe(1)
    expect(spawnCalls).toBe(0)
  })

  test("#given a model visible to the child profile #when started #then admission completes before spawn", async () => {
    // given
    const order: string[] = []
    const options = {
      modelAdmission: async () => {
        order.push("admit")
      },
      spawnChild: (descriptor: RpcSpawnDescriptor) => {
        order.push("spawn")
        const child = spawnFakeChild(descriptor.env)
        children.push(child)
        return child
      },
    }
    const runner = new RpcProcessRunner(options)

    // when
    await runner.start(makeSpec("fixture/visible"))

    // then
    expect(order).toEqual(["admit", "spawn"])
  })
})

import { describe, expect, it } from "bun:test"
import {
  childEnv,
  isReentry,
  REENTRY_ENV_VAR,
  runTestFast,
  testFastGroups,
  type TestFastGroup,
} from "./test-fast"

describe("isReentry", () => {
  it("#given an env without the active marker #when the guard is asked #then it reports no re-entry", () => {
    // given
    const env = { PATH: "/usr/bin" }

    // when
    const reentry = isReentry(env)

    // then
    expect(reentry).toBe(false)
  })

  it("#given an env carrying the active marker #when the guard is asked #then it reports re-entry", () => {
    // given
    const env = { [REENTRY_ENV_VAR]: "1" }

    // when
    const reentry = isReentry(env)

    // then
    expect(REENTRY_ENV_VAR).toBe("OMO_TEST_FAST_ACTIVE")
    expect(reentry).toBe(true)
  })

  it("#given the marker set to an empty string #when the guard is asked #then it reports no re-entry", () => {
    // given
    const env = { [REENTRY_ENV_VAR]: "" }

    // when
    const reentry = isReentry(env)

    // then
    expect(reentry).toBe(false)
  })
})

describe("childEnv", () => {
  it("#given a parent env #when a group child env is built #then the parent entries survive and the marker is added", () => {
    // given
    const parent = { PATH: "/usr/bin", CI: "true" }

    // when
    const env = childEnv(parent)

    // then
    expect(env.PATH).toBe("/usr/bin")
    expect(env.CI).toBe("true")
    expect(env[REENTRY_ENV_VAR]).toBe("1")
    expect(isReentry(env)).toBe(true)
  })
})

describe("runTestFast", () => {
  it("#given three fixed test groups #when the runner starts #then every group is launched before any exit is released", async () => {
    // given
    const order: string[] = []
    const spawnGroup = async (group: TestFastGroup) => {
      order.push(`start:${group.name}`)
      await Promise.resolve()
      order.push(`exit:${group.name}`)
      return 0
    }

    // when
    const exit = await runTestFast(spawnGroup)

    // then
    expect(testFastGroups().length).toBe(3)
    expect(order.indexOf("start:senpi")).toBeLessThan(
      order.indexOf("exit:opencode-memory"),
    )
    expect(exit).toBe(0)
  })

  it("#given one nonzero group exit #when the runner aggregates #then the combined exit is 1", async () => {
    // given
    const spawnGroup = async (group: TestFastGroup) =>
      group.name === "root-rest" ? 3 : 0

    // when
    const exit = await runTestFast(spawnGroup)

    // then
    expect(exit).toBe(1)
  })
})

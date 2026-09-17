/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test"
import {
  loadSenpiBarrel,
  SenpiHostSymbolMissingError,
  senpiDecideHostAction,
  senpiEngineBuildIdentity,
  senpiEnsureHost,
  senpiHandoffHost,
  senpiProbeHost,
  senpiRpcClient,
  senpiStopHost,
} from "./senpi-barrel"

describe("senpi host-daemon accessors", () => {
  test("#given the warmed barrel #when a symbol the pinned engine exports is read #then the live value comes back", async () => {
    // given
    await loadSenpiBarrel()

    // when
    const ensure = senpiEnsureHost()
    const client = senpiRpcClient()

    // then
    expect(typeof ensure).toBe("function")
    expect(typeof client).toBe("function")
  })

  test("#given the warmed barrel #when a symbol this pin predates is read #then a typed error names it", async () => {
    // given
    await loadSenpiBarrel()
    const pending = [
      ["probeHost", senpiProbeHost],
      ["stopHost", senpiStopHost],
      ["handoffHost", senpiHandoffHost],
      ["decideHostAction", senpiDecideHostAction],
      ["engineBuildIdentity", senpiEngineBuildIdentity],
    ] as const

    // when
    const failures = pending.map(([name, accessor]) => {
      try {
        accessor()
        return { name, missing: false, named: true }
      } catch (error) {
        return {
          name,
          missing: error instanceof SenpiHostSymbolMissingError,
          named: error instanceof SenpiHostSymbolMissingError && error.symbol === name,
        }
      }
    })

    // then
    // TRIPWIRE: the pinned engine (2026.9.17) predates senpi todos 15-17/20, so each accessor above
    // still fails closed with the symbol it needs. When the pin moves to the release that carries
    // the host-daemon exports, these move to the resolved test above instead of being deleted.
    expect(failures.filter((entry) => entry.missing).map((entry) => entry.name)).toEqual(
      pending.map(([name]) => name),
    )
    expect(failures.every((entry) => entry.named)).toBe(true)
  })
})

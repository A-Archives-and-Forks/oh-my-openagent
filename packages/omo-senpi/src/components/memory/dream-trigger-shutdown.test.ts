import { describe, expect, test } from "bun:test"
import { createShutdownDrain } from "./shutdown-drain"
import { DREAM_VOLUME_GATE_BYTES, evaluateDreamGates, resolveDreamTriggerSettings, type DreamTriggerSession } from "./dream-trigger"
import { memorySettings } from "./memory.test-support"
import { CONVERSATION, NOW_MS, fireTimer, fixture, gateProbe, noopSteps, settle, triggerSettings } from "./dream-trigger.test-support"

describe("dream shutdown evaluator", () => {
  test("#given every gate passing #when a quit drains through the registered evaluator #then a shutdown dream launches", async () => {
    const f = await fixture()
    const drain = createShutdownDrain({ steps: noopSteps })
    drain.registerEvaluator(f.wiring.shutdownEvaluator())
    await drain.run({ reason: "quit", sessionId: CONVERSATION, deadlineAt: NOW_MS + 1500, now: () => NOW_MS })
    expect(f.launches).toHaveLength(1)
    expect(f.launches[0]?.request.trigger).toBe("dream")
    expect(f.launches[0]?.request.origin).toBe("shutdown")
  })

  test("#given every gate passing #when a non-quit shutdown drains #then the evaluator never runs", async () => {
    const f = await fixture()
    const drain = createShutdownDrain({ steps: noopSteps })
    drain.registerEvaluator(f.wiring.shutdownEvaluator())
    await drain.run({ reason: "reload", sessionId: CONVERSATION, deadlineAt: NOW_MS + 1500, now: () => NOW_MS })
    expect(f.launches).toHaveLength(0)
    expect(await f.store.readState()).toEqual({})
  })

  test("#given shutdown_launch disabled #when the evaluator runs #then no reservation is made", async () => {
    const f = await fixture({ settings: { shutdownLaunch: false } })
    await f.wiring.shutdownEvaluator()({
      reason: "quit",
      sessionId: CONVERSATION,
      deadlineAt: NOW_MS + 1500,
      signal: new AbortController().signal,
    })
    expect(f.launches).toHaveLength(0)
    expect(await f.store.readState()).toEqual({})
  })

  test("#given a dream one hour ago #when the evaluator runs #then the spacing gate blocks the launch", async () => {
    const f = await fixture({ lastDreamAt: new Date(NOW_MS - 3_600_000).toISOString() })
    await f.wiring.shutdownEvaluator()({
      reason: "quit",
      sessionId: CONVERSATION,
      deadlineAt: NOW_MS + 1500,
      signal: new AbortController().signal,
    })
    expect(f.launches).toHaveLength(0)
    expect(await f.store.readState()).toEqual({})
  })

  test("#given a pre-aborted drain signal #when the evaluator runs #then no reservation is made", async () => {
    const f = await fixture()
    const controller = new AbortController()
    controller.abort()
    await f.wiring.shutdownEvaluator()({
      reason: "quit",
      sessionId: CONVERSATION,
      deadlineAt: NOW_MS + 1500,
      signal: controller.signal,
    })
    expect(f.launches).toHaveLength(0)
    expect(await f.store.readState()).toEqual({})
  })

  test("#given abort arrives while shutdown reservation is in flight #when the reservation returns active #then no dream child launch starts", async () => {
    let releaseReservation: (() => void) | undefined
    const reservationReleased = new Promise<void>((resolve) => { releaseReservation = resolve })
    let signalReservationStarted: (() => void) | undefined
    const reservationStarted = new Promise<void>((resolve) => { signalReservationStarted = resolve })
    let reserve: DreamTriggerSession["store"]["tryReserve"] | undefined
    const f = await fixture({
      reservationStore: {
        tryReserve: async (request) => {
          signalReservationStarted?.()
          await reservationReleased
          if (reserve === undefined) throw new Error("reservation delegate unavailable")
          return reserve(request)
        },
      },
    })
    reserve = f.store.tryReserve.bind(f.store)
    const controller = new AbortController()
    const evaluating = f.wiring.shutdownEvaluator()({
      reason: "quit",
      sessionId: CONVERSATION,
      deadlineAt: NOW_MS + 1500,
      signal: controller.signal,
    })
    await Promise.race([
      reservationStarted,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("shutdown reservation did not start")), 2_000)),
    ])

    controller.abort()
    releaseReservation?.()
    await evaluating

    expect(f.launches).toHaveLength(0)
  })
})

import type {
  BtwPromptRef,
  BtwSideControllerDependencies,
  BtwSideState,
} from "./tui-controller-types"
import {
  abortBtwSide,
  deleteBtwSide,
} from "./tui-side-removal"
import { createBtwPromptQueue } from "./tui-prompt-queue"
import { prepareBtwSideStart } from "./tui-side-start"

export function createBtwSideController(
  dependencies: BtwSideControllerDependencies,
) {
  let currentState: BtwSideState = { phase: "closed" }
  let stateGeneration = 0
  let disposed = false
  const promptQueue = createBtwPromptQueue()

  function setState(nextState: BtwSideState): void {
    currentState = nextState
    stateGeneration += 1
    if (!disposed) dependencies.requestRender()
  }

  function isClosingGeneration(generation: number): boolean {
    return (
      stateGeneration === generation &&
      currentState.phase === "closing"
    )
  }

  function attachPromptRef(sessionID: string, promptRef: BtwPromptRef | undefined): void {
    promptQueue.attach(sessionID, promptRef)
  }

  async function startFromPrompt(promptRef: BtwPromptRef): Promise<void> {
    if (disposed) return
    if (currentState.phase !== "closed") {
      dependencies.showToast(
        currentState.phase === "creating"
          ? "BTW is already starting."
          : "A BTW conversation is already open.",
      )
      return
    }

    const prepared = prepareBtwSideStart(dependencies, promptRef)
    if (!prepared) return
    if (prepared.consumeDraft) promptRef.set("")
    setState({
      phase: "creating",
      parentSessionID: prepared.parentSessionID,
    })

    try {
      const sideSession = await dependencies.createSession(prepared.createInput)
      if (disposed) {
        currentState = { phase: "closed" }
        try {
          await dependencies.deleteSession(sideSession.id)
        } catch {
          dependencies.showToast("Unable to remove cancelled BTW.")
        }
        return
      }
      if (prepared.question.length > 0) {
        promptQueue.queue(sideSession.id, prepared.question)
      }
      setState({
        phase: "open",
        parentSessionID: prepared.parentSessionID,
        sideSessionID: sideSession.id,
        owned: true,
      })
      dependencies.navigateSession(sideSession.id)
    } catch {
      if (disposed) {
        currentState = { phase: "closed" }
        return
      }
      if (prepared.consumeDraft) promptRef.set(prepared.originalDraft)
      setState({ phase: "closed" })
      dependencies.showToast("Unable to start BTW.")
    }
  }

  function toggle(): void {
    if (currentState.phase !== "open") return
    const currentSessionID = dependencies.getCurrentSessionID()
    if (currentSessionID === currentState.sideSessionID) {
      dependencies.navigateSession(currentState.parentSessionID)
      return
    }
    if (currentSessionID === currentState.parentSessionID) {
      dependencies.navigateSession(currentState.sideSessionID)
    }
  }

  async function close(): Promise<void> {
    if (currentState.phase !== "open") return
    const openState = currentState
    const closingState = {
      phase: "closing",
      parentSessionID: openState.parentSessionID,
      sideSessionID: openState.sideSessionID,
      owned: openState.owned,
    } as const
    setState(closingState)
    const closingGeneration = stateGeneration
    await abortBtwSide({
      sessionID: openState.sideSessionID,
      abortSession: dependencies.abortSession,
      showToast: dependencies.showToast,
    })
    if (!isClosingGeneration(closingGeneration)) return
    dependencies.navigateSession(openState.parentSessionID)
    const deleted = await deleteBtwSide({
      sessionID: openState.sideSessionID,
      deleteSession: dependencies.deleteSession,
      showToast: () => undefined,
      failureMessage: "Unable to close BTW.",
    })
    if (!isClosingGeneration(closingGeneration)) return
    if (!deleted) {
      promptQueue.clear(openState.sideSessionID)
      setState({ phase: "closed" })
      dependencies.showToast(
        "Unable to delete BTW. Delete the abandoned side session manually.",
      )
      return
    }
    promptQueue.clear(openState.sideSessionID)
    setState({ phase: "closed" })
  }

  async function handleNavigation(sessionID: string): Promise<void> {
    if (currentState.phase !== "open") return
    if (
      sessionID === currentState.parentSessionID ||
      sessionID === currentState.sideSessionID
    ) {
      return
    }
    const openState = currentState
    setState({
      phase: "closing",
      parentSessionID: openState.parentSessionID,
      sideSessionID: openState.sideSessionID,
      owned: openState.owned,
    })
    if (openState.owned) {
      await abortBtwSide({
        sessionID: openState.sideSessionID,
        abortSession: dependencies.abortSession,
        showToast: dependencies.showToast,
      })
      await deleteBtwSide({
        sessionID: openState.sideSessionID,
        deleteSession: dependencies.deleteSession,
        showToast: dependencies.showToast,
        failureMessage: "Unable to discard BTW.",
      })
    }
    promptQueue.clear(openState.sideSessionID)
    setState({ phase: "closed" })
  }

  function handleSessionDeleted(sessionID: string): void {
    if (
      currentState.phase !== "open" &&
      currentState.phase !== "closing"
    ) {
      return
    }
    if (sessionID === currentState.sideSessionID) {
      const parentSessionID = currentState.parentSessionID
      promptQueue.clear(currentState.sideSessionID)
      setState({ phase: "closed" })
      if (dependencies.getCurrentSessionID() === sessionID) {
        dependencies.navigateSession(parentSessionID)
      }
      return
    }
    if (sessionID === currentState.parentSessionID) {
      const sideSessionID = currentState.sideSessionID
      promptQueue.clear(sideSessionID)
      setState({ phase: "closed" })
      if (dependencies.getCurrentSessionID() === sessionID) {
        dependencies.navigateSession(sideSessionID)
      }
      dependencies.showToast(
        "BTW detached because its main session was deleted.",
      )
    }
  }

  function canCloseCurrentSide(): boolean {
    if (currentState.phase !== "open") return false
    if (dependencies.getCurrentSessionID() !== currentState.sideSessionID) {
      return false
    }
    return promptQueue.input(currentState.sideSessionID).length === 0
  }

  function adopt(parentSessionID: string, sideSessionID: string): void {
    if (currentState.phase !== "closed") return
    setState({
      phase: "open",
      parentSessionID,
      sideSessionID,
      owned: false,
    })
  }

  return {
    state: (): BtwSideState => currentState,
    startFromPrompt,
    attachPromptRef,
    toggle,
    close,
    handleNavigation,
    handleSessionDeleted,
    canCloseCurrentSide,
    adopt,
    dispose: async (): Promise<void> => {
      disposed = true
      if (currentState.phase === "creating") {
        currentState = { phase: "closed" }
        return
      }
      if (currentState.phase !== "open") return
      if (currentState.owned) {
        await handleNavigation("")
        return
      }
      setState({ phase: "closed" })
    },
  }
}

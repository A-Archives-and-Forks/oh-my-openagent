
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createReadToolDefinition, type CreateAgentSessionOptions, type ToolDefinition } from "@code-yeongyu/senpi"

import type { ChildSession, ChildSessionListener, ChildSpec } from "./in-process"

const sampleParameters = createReadToolDefinition(process.cwd()).parameters

export function makeTool(name: string, onExecute?: () => void): ToolDefinition {
  return {
    name,
    label: name,
    description: `test tool ${name}`,
    parameters: sampleParameters,
    execute: async () => {
      onExecute?.()
      return { content: [{ type: "text", text: "ok" }], details: undefined }
    },
  }
}

type FakeSessionControls = {
  session: ChildSession
  resolvePrompt: () => void
  rejectPrompt: (error: unknown) => void
  emit: (event: { readonly type: string }) => void
  steerCalls: string[]
  followUpCalls: string[]
  abortCalls: number
  disposeCount: number
  lastText: { value: string | undefined }
  promptCalls: number
  promptTexts: string[]
}

export function createFakeSession(sessionId = "child-session-1"): FakeSessionControls {
  const listeners = new Set<ChildSessionListener>()
  const steerCalls: string[] = []
  const followUpCalls: string[] = []
  const promptTexts: string[] = []
  const lastText = { value: undefined as string | undefined }
  const counters = { abortCalls: 0, disposeCount: 0, promptCalls: 0 }
  let settle: { resolve: () => void; reject: (error: unknown) => void } | undefined
  const session: ChildSession = {
    sessionId,
    prompt(text: string) {
      counters.promptCalls += 1
      promptTexts.push(text)
      return new Promise<void>((resolve, reject) => {
        settle = { resolve, reject }
      })
    },
    async steer(text: string) {
      steerCalls.push(text)
    },
    async followUp(text: string) {
      followUpCalls.push(text)
    },
    async abort() {
      counters.abortCalls += 1
    },
    subscribe(listener: ChildSessionListener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    getLastAssistantText() {
      return lastText.value
    },
    dispose() {
      counters.disposeCount += 1
    },
  }
  return {
    session,
    steerCalls,
    followUpCalls,
    lastText,
    promptTexts,
    get abortCalls() {
      return counters.abortCalls
    },
    get disposeCount() {
      return counters.disposeCount
    },
    get promptCalls() {
      return counters.promptCalls
    },
    resolvePrompt: () => settle?.resolve(),
    rejectPrompt: (error: unknown) => settle?.reject(error),
    emit: (event) => {
      for (const listener of listeners) listener(event)
    },
  }
}

export const tmpSessionDirs: string[] = []

export function makeSessionDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "senpi-task-in-process-"))
  tmpSessionDirs.push(dir)
  return dir
}

export function baseSpec(overrides: Partial<ChildSpec> = {}): ChildSpec {
  return {
    taskId: "task-1",
    cwd: process.cwd(),
    sessionDir: makeSessionDir(),
    depth: 0,
    parentSessionId: "parent-1",
    rootSessionId: "root-1",
    prompt: "do the work",
    ...overrides,
  }
}

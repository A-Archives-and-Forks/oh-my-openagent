import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { OmoTaskSettingsSchema } from "@oh-my-opencode/omo-config-core"
import { createTaskLifecycle } from "../../packages/senpi-task/src/lifecycle"
import type { ResidencyRegistry } from "../../packages/senpi-task/src/lifecycle/port"
import { createTaskManager } from "../../packages/senpi-task/src/manager/manager"
import { TaskConcurrency } from "../../packages/senpi-task/src/manager/concurrency"
import { createTaskRecordStore } from "../../packages/senpi-task/src/store"
import { buildWorkpoolExecute } from "../../packages/senpi-task/src/tools/workpool"
import type { WorkpoolAggregateMessage } from "../../packages/senpi-task/src/workpool/aggregate.ts"

function openEnv() {
  const root = mkdtempSync(join(tmpdir(), "omp-item2-eval-"))
  const store = createTaskRecordStore({ project_dir: root })
  const config = OmoTaskSettingsSchema.parse({ default_concurrency: 1, global_concurrency: 1, residency_max_children: 4 })
  const concurrency = new TaskConcurrency(config)
  const starts: unknown[] = []
  const runner = { start: async (spec: { taskId: string }) => {
    starts.push(spec)
    return { task_id: spec.taskId, sessionId: `worker-${spec.taskId}`, waitForOutcome: () => new Promise(() => undefined), followUp: async () => undefined, steer: async () => undefined, abort: async () => undefined, dispose: async () => undefined, subscribe: () => () => undefined, lastAssistantText: () => undefined }
  } }
  const registry: ResidencyRegistry = { get: () => undefined, entries: () => [], forget: () => undefined, hasPendingSends: () => false, tryClaimEviction: () => false, releaseEviction: () => undefined }
  const lifecycle = createTaskLifecycle({ store, registry, config })
  const manager = createTaskManager({ store, concurrency, runners: { "in-process": runner, process: runner }, config, cwd: root,
    planner: spec => ({ kind: "resolved", plan: { model: spec.model ?? "test/model" } }), destruction: lifecycle, admit: async () => ({ kind: "admitted" }) })
  const caller = { sessionId: "parent", rootSessionId: "root", depth: 0, cwd: root }
  const ctx = { cwd: root, sessionManager: { getSessionId: () => caller.sessionId } }
  const execute = buildWorkpoolExecute({ manager, workpools: manager.workpools, omoConfig: {}, agents: {} })
  return { root, store, manager, lifecycle, concurrency, starts, caller, ctx, execute }
}

function bridge(execute: ReturnType<typeof buildWorkpoolExecute>, ctx: { cwd: string; sessionManager: { getSessionId: () => string } }) {
  const tool = { workpool: (args: Record<string, unknown>) => execute(args, ctx) }
  return (code: string) => new Function("tool", `return (async () => { ${code} })()`)(tool) as Promise<unknown>
}

export async function runEvalAggregate(out: string) {
  const env = openEnv()
  const messages: WorkpoolAggregateMessage[] = []
  env.manager.workpools.bindAggregate({ enqueue: message => { messages.push(message) } })
  try {
    const evalJs = bridge(env.execute, env.ctx)
    const created = await evalJs(`return await tool.workpool({ op: "create", name: "eval-batch", agent: { category: "quick", prompt: "Process input" } })`) as { details: { pool_id: `wp_${string}`; mode: string } }
    assert.equal(created.details.mode, "keep_alive")
    const poolId = created.details.pool_id
    await evalJs(`return await tool.workpool(${JSON.stringify({ op: "push", pool_id: poolId, items: [{ key: "a", input: 1 }] })})`)
    const closed = await evalJs(`return await tool.workpool(${JSON.stringify({ op: "close", pool_id: poolId })})`) as { details: { pool_id: string; generation: number; status: string } }
    assert.equal(closed.details.status, "closing")
    assert.equal(messages.length, 0)
    env.manager.workpools.cancel(env.caller, poolId)
    assert.equal(messages.length, 1)
    assert.equal(messages[0]?.results[0]?.key, "a")
    env.manager.workpools.dispose()
    const reset = openReset(env.root)
    try {
      const inspected = await buildWorkpoolExecute({ manager: reset.manager, workpools: reset.manager.workpools, omoConfig: {}, agents: {} })(
        { op: "inspect", pool_id: poolId }, env.ctx)
      assert.equal((inspected.details as { pool_id: string }).pool_id, poolId)
      return { passed: true, out, pool_id: poolId, mode: created.details.mode, aggregate: messages[0], inspected: inspected.details }
    } finally { reset.manager.workpools.dispose(); reset.lifecycle.dispose?.() }
  } finally { env.manager.workpools.dispose(); env.lifecycle.dispose?.(); rmSync(env.root, { recursive: true, force: true }) }
}

export async function runCancelUncertainNotify(out: string) {
  const env = openEnv()
  try {
    env.concurrency.tryAcquire("test/model", "st_00000001", 0)
    env.manager.workpools.bindAggregate({ enqueue: () => { throw new Error("notifier down") } })
    const created = await env.execute({ op: "create", name: "fail-batch", agent: { category: "quick", prompt: "Process input" }, mode: "fresh" }, env.ctx)
    const poolId = (created.details as { pool_id: `wp_${string}` }).pool_id
    const waiting = env.manager.workpools.waitForEvent(poolId, "waiting", AbortSignal.timeout(5000))
    await env.execute({ op: "push", pool_id: poolId, items: [{ key: "late", input: 1 }] }, env.ctx)
    await waiting
    assert.equal(env.starts.length, 0)
    await env.execute({ op: "cancel", pool_id: poolId }, env.ctx)
    assert.equal(env.starts.length, 0)
    const inspected = await env.execute({ op: "inspect", pool_id: poolId }, env.ctx)
    assert.equal((inspected.details as { items: { status: string }[] }).items[0]?.status, "cancelled")
    assert.notEqual((inspected.details as { aggregate?: { delivered: boolean } }).aggregate?.delivered, true)
    const denied = await env.execute({ op: "inspect", pool_id: poolId }, { ...env.ctx, sessionManager: { getSessionId: () => "foreign" } })
    assert.equal((denied.details as { error: { code: string } }).error.code, "scope_denied")
    return { passed: true, out, zeroCapacityPush: { starts: env.starts.length }, cancelled: true, notifierPending: true, crossSession: "scope_denied" }
  } finally { env.manager.workpools.dispose(); env.lifecycle.dispose?.(); rmSync(env.root, { recursive: true, force: true }) }
}

function openReset(root: string) {
  const store = createTaskRecordStore({ project_dir: root })
  const config = OmoTaskSettingsSchema.parse({ default_concurrency: 1, global_concurrency: 1, residency_max_children: 4 })
  const concurrency = new TaskConcurrency(config)
  const runner = { start: async (spec: { taskId: string }) => ({ task_id: spec.taskId, sessionId: `worker-${spec.taskId}`, waitForOutcome: () => new Promise(() => undefined), followUp: async () => undefined, steer: async () => undefined, abort: async () => undefined, dispose: async () => undefined, subscribe: () => () => undefined, lastAssistantText: () => undefined }) }
  const registry: ResidencyRegistry = { get: () => undefined, entries: () => [], forget: () => undefined, hasPendingSends: () => false, tryClaimEviction: () => false, releaseEviction: () => undefined }
  const lifecycle = createTaskLifecycle({ store, registry, config })
  const manager = createTaskManager({ store, concurrency, runners: { "in-process": runner, process: runner }, config, cwd: root,
    planner: spec => ({ kind: "resolved", plan: { model: spec.model ?? "test/model" } }), destruction: lifecycle, admit: async () => ({ kind: "admitted" }) })
  return { manager, lifecycle }
}

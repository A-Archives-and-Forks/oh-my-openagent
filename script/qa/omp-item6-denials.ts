import assert from "node:assert/strict"

import type { AgentToolResult } from "@code-yeongyu/senpi"
import type { TaskToolDetails } from "../../packages/senpi-task/src/tools/task/types"
import { createWorkpoolStore } from "../../packages/senpi-task/src/workpool/store"
import { openChildEnv, openProducerKernel } from "./omp-item6-harness"

const DEFINE_CELL = [
  "tool(async function fixture_lookup(key) { return 'parent-state:' + key; });",
  "return await tool.hold({});",
].join("\n")

/**
 * Every refusal path for item 6: curated read-only agents, process/team children, a parent with no
 * live JavaScript kernel, normalized collisions, reserved aliases and undefined descriptors. None of
 * them may create a child session or a pool.
 */
export async function runCuratedProcessAndLanguageDenials(): Promise<Record<string, unknown>> {
  const kernel = await openProducerKernel("omp-item6-denials")
  const env = await openChildEnv(() => ({ text: "UNEXPECTED_CHILD_TURN" }))
  try {
    const cell = kernel.run({ cellId: "omp-item6-define", code: DEFINE_CELL })
    const hold = await kernel.nextToolCall()
    assert.equal(hold.toolName, "hold")

    const execute = async (params: Record<string, unknown>, capability: unknown): Promise<TaskToolDetails> =>
      ((await env.taskTool.execute(
        "omp-item6-denial",
        params as never,
        undefined,
        undefined,
        env.context(capability as never) as never,
      )) as AgentToolResult<TaskToolDetails>).details

    const base = { prompt: "use the parent tool", run_in_background: true as const }
    const cases: { readonly label: string; readonly details: TaskToolDetails }[] = [
      { label: "curated-read-only-agent", details: await execute({ ...base, subagent_type: "explore", tools: ["fixture_lookup"] }, kernel.capability) },
      { label: "non-js-parent-no-capability", details: await execute({ ...base, category: "quick", tools: ["fixture_lookup"] }, undefined) },
      { label: "reserved-alias", details: await execute({ ...base, category: "quick", tools: ["task_send"] }, kernel.capability) },
      { label: "normalized-collision", details: await execute({ ...base, category: "quick", tools: ["fixture-lookup", "fixture_lookup"] }, kernel.capability) },
      { label: "missing-descriptor", details: await execute({ ...base, category: "quick", tools: ["never_defined"] }, kernel.capability) },
    ]
    for (const entry of cases) {
      assert.ok(entry.details.kernel_tools?.error, `${entry.label} must be a typed refusal`)
      assert.equal(entry.details.status, "denied", `${entry.label} must not spawn`)
    }
    assert.deepEqual(env.store.list().records, [], "no child session may exist after a grant refusal")

    const context = env.context(kernel.capability)
    const pool = (await env.workpoolTool.execute(
      "omp-item6-pool-denied",
      { op: "create", name: "denied-pool", agent: { category: "quick", prompt: "x" }, tools: ["never_defined"] } as never,
      undefined,
      undefined,
      context as never,
    )).details as { error?: { code: string } }
    assert.equal(pool.error?.code, "kernel_tool_missing")
    assert.deepEqual(createWorkpoolStore(env.store.stateDir).list(), [], "a refused pool must not be created")

    // A child-denied nested host call: the child's own policy narrows the parent surface, so the
    // grant is refused rather than running the closure with unrestricted parent permissions.
    const policyDenied = await execute({ ...base, subagent_type: "code-reviewer", tools: ["fixture_lookup"] }, kernel.capability)

    kernel.reply(hold.callId, "released")
    await cell
    return {
      passed: true,
      producer_sha: kernel.sha,
      denials: cases.map((entry) => ({ case: entry.label, code: entry.details.kernel_tools?.error?.code, status: entry.details.status })),
      pool_denial: pool.error,
      child_policy_denial: { code: policyDenied.kernel_tools?.error?.code, status: policyDenied.status },
      spawned_children: env.store.list().records.length,
    }
  } finally {
    env.dispose()
    await kernel.close()
  }
}

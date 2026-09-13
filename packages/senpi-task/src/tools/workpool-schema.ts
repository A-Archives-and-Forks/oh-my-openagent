import { Type } from "typebox"

const nonempty = Type.String({ minLength: 1, pattern: "\\S" })
// A JSON Schema's unconstrained value covers every JSON value. The execution boundary also
// rejects non-JSON JavaScript values (undefined, functions and non-finite numbers).
const json = Type.Unknown()
const agent = Type.Union([
  Type.Object({ category: nonempty, prompt: nonempty, model: Type.Optional(nonempty) }, { additionalProperties: false }),
  Type.Object({ subagent_type: nonempty, prompt: nonempty, model: Type.Optional(nonempty) }, { additionalProperties: false }),
])
const poolId = Type.String({ pattern: "^wp_[0-9a-f]{32}$" })
export const WorkpoolYieldParams = Type.Object({
  op: Type.Literal("yield"),
  results: Type.Array(Type.Union([
    Type.Object({ key: nonempty, data: json }, { additionalProperties: false }),
    Type.Object({ key: nonempty, error: Type.Object({ code: nonempty, message: nonempty }, { additionalProperties: false }) }, { additionalProperties: false }),
  ])),
}, { additionalProperties: false })
export const WorkpoolParams = Type.Union([
  Type.Object({ op: Type.Literal("create"), name: nonempty, agent, mode: Type.Union([Type.Literal("fresh"), Type.Literal("keep_alive")]), tools: Type.Optional(Type.Array(nonempty)) }, { additionalProperties: false }),
  Type.Object({ op: Type.Literal("push"), pool_id: poolId, items: Type.Array(Type.Object({ key: nonempty, input: json }, { additionalProperties: false })) }, { additionalProperties: false }),
  Type.Object({ op: Type.Literal("close"), pool_id: poolId }, { additionalProperties: false }),
  Type.Object({ op: Type.Literal("inspect"), pool_id: poolId }, { additionalProperties: false }),
  Type.Object({ op: Type.Literal("cancel"), pool_id: poolId }, { additionalProperties: false }),
  WorkpoolYieldParams,
])

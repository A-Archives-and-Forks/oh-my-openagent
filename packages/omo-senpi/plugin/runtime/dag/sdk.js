// Dependency-free convenience wrapper around the `dag` tool, loaded by JavaScript eval cells from
// OMO_DAG_SDK_ROOT. It must stay import-free: the eval worker has no node_modules on its resolver
// path, so anything this file imports would break the cell at load time.
//
// Every call funnels through globalThis.tool.dag({ action, ... }), the proxy the JS kernel installs
// (senpi packages/senpi-codemode/src/kernels/js/worker-runtime.js). Python cells cannot import ESM
// and call tool.dag({...}) directly instead; there is no Python counterpart to this file.

function callDag(args) {
  const proxy = globalThis.tool
  if (proxy === undefined || proxy === null || typeof proxy.dag !== "function") {
    throw new Error("The dag sdk requires the eval kernel's global `tool` proxy; it is unavailable here.")
  }
  return proxy.dag(args)
}

class DagDefinitionBuilder {
  constructor(key, name) {
    this.key = key
    this.name = name
    this.nodes = []
    this.ids = new Set()
  }

  // Rejects duplicates locally so a mistyped graph fails in the cell, before any host round-trip.
  node(input) {
    if (input === undefined || input === null || typeof input.id !== "string" || input.id === "") {
      throw new Error("A dag node needs a non-empty string id.")
    }
    if (this.ids.has(input.id)) {
      throw new Error(`Duplicate dag node id "${input.id}": every node id must be unique within a definition.`)
    }
    this.ids.add(input.id)
    this.nodes.push(input)
    return this
  }

  definition() {
    return this.name === undefined
      ? { key: this.key, nodes: this.nodes }
      : { key: this.key, name: this.name, nodes: this.nodes }
  }

  start() {
    return start(this.definition())
  }
}

export function define(input) {
  if (input === undefined || input === null || typeof input.key !== "string" || input.key === "") {
    throw new Error("define() needs a non-empty string key: it is the run's idempotency key.")
  }
  return new DagDefinitionBuilder(input.key, input.name)
}

export function start(definition) {
  return callDag({ action: "start", definition })
}

export function attach(runId) {
  return callDag({ action: "attach", run_id: runId })
}

export function snapshot(runId) {
  return callDag({ action: "snapshot", run_id: runId })
}

export function wait(runId) {
  return callDag({ action: "wait", run_id: runId })
}

export function cancel(runId, reason) {
  return reason === undefined
    ? callDag({ action: "cancel", run_id: runId })
    : callDag({ action: "cancel", run_id: runId, reason })
}

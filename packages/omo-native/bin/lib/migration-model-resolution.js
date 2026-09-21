// A preserved provider must be checked with the engine's actual composition,
// including built-ins and disable/filter rules. Load the declared engine SDK
// only for this case; catalog inspection never needs credentials or network I/O.
export async function canResolveExistingModel(modelsPath, provider, model) {
  const { ModelRuntime } = await import("@code-yeongyu/senpi")
  const runtime = ModelRuntime.createSync({
    modelsPath,
    allowModelNetwork: false,
    refreshOnCreate: false,
    credentials: {
      async read() { return undefined },
      async list() { return [] },
      async modify() { throw new Error("Migration catalog inspection cannot modify credentials") },
      async delete() { throw new Error("Migration catalog inspection cannot delete credentials") },
    },
  })
  return runtime.getModel(provider, model) !== undefined
}

import { createRequire } from "node:module"

const require = createRequire(import.meta.url)

export function markChildStage(stage: string): void {
  const modules = Object.keys(require.cache).map(path => path.replaceAll("\\", "/"))
  const relevant = modules.filter(path => /\/(workpool|member-extension)\/|\/spawn-policy\./.test(path))
    .map(path => path.slice(path.lastIndexOf("/src/") + 5))
  console.error(`COLD_REVIVE_CHILD ${JSON.stringify({ stage, elapsed_ms: performance.now(), cpu: process.cpuUsage(), modules: modules.length, relevant })}`)
}

markChildStage("bootstrap")

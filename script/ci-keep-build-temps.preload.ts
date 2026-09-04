// Diagnostic preload (temporary): keep .build-check-* and .build-extension-test-* trees so a
// fixture-vs-rebuild mismatch on the runner can be diffed. Never ships; removed before merge.
import * as fsp from "node:fs/promises"
const realRm = fsp.rm
;(fsp as { rm: typeof fsp.rm }).rm = (async (path: Parameters<typeof fsp.rm>[0], options?: Parameters<typeof fsp.rm>[1]) => {
  const p = String(path)
  if (/\.build-(check|extension-test)-/.test(p)) return
  return realRm(path, options)
}) as typeof fsp.rm

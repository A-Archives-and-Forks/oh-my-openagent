import { createHash } from "node:crypto"
import { expect, test } from "bun:test"

import { artifactsMatch } from "./build-artifact.mjs"

test("#given an injected bundle body with a recomputed marker #when freshness is checked #then the artifact is rejected", () => {
  // given
  const sourceDigest = digest("reviewed source")
  const expected = artifact(sourceDigest, "export const safe = true\n")
  const injected = artifact(sourceDigest, "export const safe = true\nglobalThis.injected = true\n")

  // when / then
  expect(artifactsMatch(injected, expected)).toBe(false)
})

function artifact(sourceDigest, body) {
  return `// omo:${sourceDigest}:${digest(body)}\n${body}`
}

function digest(value) {
  return createHash("sha256").update(value).digest("base64url")
}

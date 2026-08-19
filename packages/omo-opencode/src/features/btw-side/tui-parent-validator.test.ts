import { describe, expect, it, mock } from "bun:test"

import { createBtwParentValidator } from "./tui-parent-validator"

function createDeferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

describe("createBtwParentValidator", () => {
  it("#given a persisted side #when its parent is remote or deleted during lookup #then only an existing parent validates", async () => {
    // given
    const remoteResults = [false, true]
    const fetchExists = mock(async () => remoteResults.shift() ?? false)
    const validator = createBtwParentValidator({
      localExists: () => false,
      fetchExists,
    })

    // then
    expect(await validator.exists("ses_parent")).toBe(false)
    expect(await validator.exists("ses_parent")).toBe(true)

    // given
    const deferred = createDeferred<boolean>()
    const racingValidator = createBtwParentValidator({
      localExists: () => false,
      fetchExists: () => deferred.promise,
    })
    const validation = racingValidator.exists("ses_deleted_parent")

    // when
    racingValidator.markDeleted("ses_deleted_parent")
    deferred.resolve(true)

    // then
    expect(await validation).toBe(false)
  })
})

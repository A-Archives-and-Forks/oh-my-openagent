import { describe, expect, it, mock } from "bun:test"

import { unsafeTestValue } from "../../../../../test-support/unsafe-test-value"
import { registerBtwSideKeymap } from "./tui-keymap"

type TestCommand = {
  name: string
  run?: () => void | Promise<void>
}

type TestLayer = {
  commands?: TestCommand[]
  bindings?: Array<{
    key: string
    cmd: string
  }>
}

describe("registerBtwSideKeymap", () => {
  it("#given retained BTW sessions #when switch bindings register #then every Ctrl slash encoding opens the picker", async () => {
    // given
    const layers: TestLayer[] = []
    const openPicker = mock(async () => undefined)
    const toggle = mock(() => undefined)
    const api = unsafeTestValue({
      keymap: {
        registerLayer: (layer: TestLayer) => {
          layers.push(layer)
          return () => undefined
        },
      },
      mode: {
        current: () => "base",
      },
    })
    const controller = unsafeTestValue({
      state: () => ({
        phase: "open",
        parentSessionID: "ses_parent",
        sideSessionID: "ses_side",
        owned: true,
      }),
      toggle,
      canCloseCurrentSide: () => true,
      close: async () => undefined,
    })

    // when
    registerBtwSideKeymap(unsafeTestValue({
      api,
      controller,
      activePromptRef: () => undefined,
      openBtw: async () => undefined,
      openPicker,
    }))
    const switchCommand = layers
      .flatMap((layer) => layer.commands ?? [])
      .find((command) => command.name === "omo.btw.toggle")
    await switchCommand?.run?.()

    // then
    expect(
      layers.flatMap((layer) => layer.bindings ?? []),
    ).toEqual(
      expect.arrayContaining([
        {
          key: "ctrl+/",
          cmd: "omo.btw.toggle",
        },
        {
          key: "ctrl+_",
          cmd: "omo.btw.toggle",
        },
        {
          key: "ctrl+7",
          cmd: "omo.btw.toggle",
        },
      ]),
    )
    expect(openPicker).toHaveBeenCalledTimes(1)
    expect(toggle).not.toHaveBeenCalled()
  })
})

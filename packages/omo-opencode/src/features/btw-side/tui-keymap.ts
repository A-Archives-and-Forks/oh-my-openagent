import type {
  TuiPluginApi,
  TuiPromptRef,
} from "@opencode-ai/plugin/tui"

import { isBtwCommandDraft } from "./btw-command-draft"
import type { createBtwSideController } from "./tui-controller"
import { createBtwEscapeReturn } from "./tui-escape-return"

type BtwSideController = ReturnType<typeof createBtwSideController>

export type BtwSideKeymapRegistration = {
  unregister: Array<() => void>
  resetEscapeSequence: () => void
}

export function registerBtwSideKeymap(args: {
  api: TuiPluginApi
  controller: BtwSideController
  activePromptRef: () => TuiPromptRef | undefined
  openBtw: () => Promise<void>
  openPicker: () => Promise<void>
  isCurrentSideIdle: () => boolean
  returnToParent: () => void
}): BtwSideKeymapRegistration {
  const escapeReturn = createBtwEscapeReturn({
    isCurrentSideIdle: args.isCurrentSideIdle,
    isDialogOpen: () => args.api.ui.dialog?.open ?? false,
    clearPending: () => args.api.keymap.clearPendingSequence(),
    returnToParent: args.returnToParent,
  })
  const unregisterEscape =
    args.api.keymap.intercept?.(
      "key",
      escapeReturn.handle,
      {
        priority: 50_000,
      },
    ) ?? (() => undefined)
  const unregisterCommandLayer = args.api.keymap.registerLayer({
    mode: args.api.mode.current(),
    priority: 20_000,
    commands: [
      {
        name: "omo.btw.open",
        title: "Start BTW side conversation",
        desc: "start a side conversation in an ephemeral session",
        category: "Session",
        namespace: "palette",
        enabled: true,
        run: () => args.openBtw(),
      },
      {
        name: "omo.btw.toggle",
        title: "Switch BTW conversation",
        hidden: true,
        enabled: true,
        run: () => args.openPicker(),
      },
      {
        name: "omo.btw.close",
        title: "Close BTW conversation",
        hidden: true,
        enabled: () => args.controller.canCloseCurrentSide(),
        run: () => args.controller.close(),
      },
    ],
    bindings: [
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
      {
        key: "ctrl+c",
        cmd: "omo.btw.close",
        preventDefault: true,
        fallthrough: false,
      },
    ],
  })

  const unregisterInlineLayer = args.api.keymap.registerLayer({
    mode: args.api.mode.current(),
    priority: 10_000,
    enabled: () => {
      const promptRef = args.activePromptRef()
      return promptRef ? isBtwCommandDraft(promptRef.current.input) : false
    },
    bindings: [
      {
        key: "enter,return",
        cmd: "omo.btw.open",
      },
    ],
  })

  return {
    unregister: [
      unregisterEscape,
      unregisterInlineLayer,
      unregisterCommandLayer,
    ],
    resetEscapeSequence: escapeReturn.reset,
  }
}


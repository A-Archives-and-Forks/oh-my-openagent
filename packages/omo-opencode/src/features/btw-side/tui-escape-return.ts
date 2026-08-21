import type { KeyEvent } from "@opentui/core"
import type { KeyInputContext } from "@opentui/keymap"

export function createBtwEscapeReturn(args: {
  isCurrentSideIdle: () => boolean
  isDialogOpen: () => boolean
  clearPending: () => void
  returnToParent: () => void
}) {
  let firstEscapePending = false

  function reset(): void {
    firstEscapePending = false
  }

  function handle(context: KeyInputContext<KeyEvent>): void {
    if (
      context.event.eventType !== "press" ||
      context.event.name !== "escape"
    ) {
      if (context.event.eventType !== "release") reset()
      return
    }
    if (args.isDialogOpen() || !args.isCurrentSideIdle()) {
      reset()
      return
    }
    if (!firstEscapePending) {
      firstEscapePending = true
      return
    }

    reset()
    args.clearPending()
    context.consume({
      preventDefault: true,
      stopPropagation: true,
    })
    args.returnToParent()
  }

  return {
    handle,
    reset,
  }
}

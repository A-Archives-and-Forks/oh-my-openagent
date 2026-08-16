import { spawnSync } from "node:child_process"
import { dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, test } from "bun:test"

const isWin32 = process.platform === "win32"
const probePath = fileURLToPath(
  new URL(
    "../../../../.omo/evidence/omo-senpi-adapter/20260814-senpi-task-windows-console/windows-console-probe.ts",
    import.meta.url,
  ),
)

test.skipIf(!isWin32)(
  "#given a console-less parent #when the default RPC child starts #then windowsHide suppresses its console",
  () => {
    // given
    const result = spawnSync(process.execPath, [probePath], {
      cwd: dirname(probePath),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      windowsHide: true,
    })

    // when
    const payload = JSON.parse(result.stdout.trim()) as {
      readonly result: string
      readonly visible: {
        readonly mainWindowHandle: number
        readonly stdioRoundTrip: boolean
        readonly childExited: boolean
      }
      readonly hidden: {
        readonly mainWindowHandle: number
        readonly stdioRoundTrip: boolean
        readonly childExited: boolean
      }
      readonly isolation: {
        readonly credentialsUntouched: boolean
      }
    }

    // then
    expect(result.stderr).toBe("")
    expect(result.status).toBe(0)
    expect(payload.result).toBe("PASS")
    expect(payload.visible.mainWindowHandle).not.toBe(0)
    expect(payload.hidden.mainWindowHandle).toBe(0)
    expect(payload.visible.stdioRoundTrip).toBe(true)
    expect(payload.hidden.stdioRoundTrip).toBe(true)
    expect(payload.visible.childExited).toBe(true)
    expect(payload.hidden.childExited).toBe(true)
    expect(payload.isolation.credentialsUntouched).toBe(true)
  },
)

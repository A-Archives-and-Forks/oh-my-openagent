import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

import manifest from "../app/manifest"

const WEB_ROOT = join(import.meta.dir, "..")

function readPngSize(path: string): { width: number; height: number } {
  const bytes = readFileSync(path)
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  expect(bytes.subarray(0, 8).equals(signature)).toBe(true)
  expect(bytes.toString("ascii", 12, 16)).toBe("IHDR")
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
}

describe("web app icons", () => {
  const icons = manifest().icons ?? []

  test("manifest ships PNG icons at 192 and 512 for installability", () => {
    const pngSizes = icons.filter((icon) => icon.type === "image/png").map((icon) => icon.sizes)
    expect(pngSizes).toEqual(expect.arrayContaining(["192x192", "512x512"]))
  })

  test("every manifest icon points at a file under public/ with its declared size", () => {
    for (const icon of icons) {
      // Static icons live in public/; Next.js metadata files (app/icon.svg) are served from app/.
      const relative = icon.src.replace(/^\//, "")
      const candidates = [join(WEB_ROOT, "public", relative), join(WEB_ROOT, "app", relative)]
      const file = candidates.find((candidate) => existsSync(candidate))
      expect(file, `${icon.src} is not served from public/ or app/`).toBeDefined()
      if (icon.type !== "image/png" || !file) continue
      const declared = /^(\d+)x(\d+)$/.exec(icon.sizes ?? "")
      expect(declared, `${icon.src} declares no WxH size`).not.toBeNull()
      if (!declared) continue
      expect(readPngSize(file)).toEqual({ width: Number(declared[1]), height: Number(declared[2]) })
    }
  })

  test("apple touch icon is a 180x180 PNG", () => {
    expect(readPngSize(join(WEB_ROOT, "app", "apple-icon.png"))).toEqual({
      width: 180,
      height: 180,
    })
  })
})

// Renders the raster app icons from app/icon.svg so every PNG the site ships is
// derived from the one vector mark. Run with `bun scripts/render-app-icons.mjs`
// after changing app/icon.svg, then commit the regenerated PNGs.
import { readFile, writeFile } from "node:fs/promises"
import { chromium } from "@playwright/test"

const webRoot = new URL("../", import.meta.url)
const iconSvg = await readFile(new URL("app/icon.svg", webRoot), "utf8")
const field = "#0a0a0a"

// fullBleed: iOS composes its own rounded mask over apple-touch icons, so that
// one must be an opaque square; the manifest PNGs keep the SVG's rounded corners.
const outputs = [
  { file: "app/apple-icon.png", size: 180, fullBleed: true },
  { file: "public/icon-192x192.png", size: 192, fullBleed: false },
  { file: "public/icon-512x512.png", size: 512, fullBleed: false },
]

const pageFor = ({ size, fullBleed }) => `<!doctype html>
<html><head><style>
  html, body { margin: 0; padding: 0; background: ${fullBleed ? field : "transparent"}; }
  #icon { display: block; width: ${size}px; height: ${size}px; }
</style></head>
<body><div id="icon">${iconSvg.replace("<svg ", `<svg width="${size}" height="${size}" `)}</div></body></html>`

const browser = await chromium.launch()
try {
  for (const output of outputs) {
    const page = await browser.newPage({
      viewport: { width: output.size, height: output.size },
      deviceScaleFactor: 1,
    })
    await page.setContent(pageFor(output))
    const png = await page.screenshot({
      type: "png",
      omitBackground: !output.fullBleed,
      clip: { x: 0, y: 0, width: output.size, height: output.size },
    })
    await page.close()
    await writeFile(new URL(output.file, webRoot), png)
    process.stdout.write(`${output.file}: ${output.size}x${output.size}, ${png.byteLength} bytes\n`)
  }
} finally {
  await browser.close()
}

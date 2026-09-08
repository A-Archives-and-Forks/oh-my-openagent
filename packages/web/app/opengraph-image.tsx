import { ImageResponse } from "next/og"
import { decodeFont, geistMediumBase64, geistMonoRegularBase64 } from "@/lib/og/fonts"
import { GraphGlyph } from "@/lib/og/graph-glyph"
import { omoLogo } from "@/lib/og/omo-logo"
import { ogPalette } from "@/lib/og/palette"
import { OgTagline } from "@/lib/og/tagline"
import { getStats, formatStats, FALLBACK_FORMATTED_STATS } from "@/lib/stats"

export const alt = "Oh My OpenAgent - the agent harness. Live GitHub stars and project one-liner."
export const size = { width: 1200, height: 630 }
export const contentType = "image/png"
export const revalidate = 3600

const { ink0, textHi, textMid, textLo, textFaint, line, accent } = ogPalette
const rule = {
  position: "absolute",
  left: 28,
  right: 28,
  height: 1,
  backgroundColor: line,
  display: "flex",
} as const

export default async function OpenGraphImage() {
  let stats = FALLBACK_FORMATTED_STATS
  try {
    stats = formatStats(await getStats())
  } catch (error) {
    console.warn("Unable to refresh social image stats; using fallback data", error)
  }

  return new ImageResponse(
    <div
      style={{
        display: "flex",
        position: "relative",
        width: "100%",
        height: "100%",
        backgroundColor: ink0,
        backgroundImage:
          "radial-gradient(circle at 82% 42%, rgba(0,212,255,0.14), rgba(0,212,255,0) 46%)",
        color: textHi,
        fontFamily: "Geist",
      }}
    >
      <div
        style={{
          position: "absolute",
          top: 28,
          left: 28,
          right: 28,
          bottom: 28,
          border: `1px solid ${line}`,
          display: "flex",
        }}
      />
      <div style={{ ...rule, top: 148 }} />
      <div style={{ ...rule, bottom: 116 }} />

      <div
        style={{
          position: "absolute",
          top: 52,
          left: 72,
          display: "flex",
          alignItems: "center",
          gap: 24,
        }}
      >
        <img
          src={"data:image/svg+xml;utf8," + encodeURIComponent(omoLogo)}
          width={72}
          height={72}
          alt=""
        />
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div
            style={{
              display: "flex",
              fontWeight: 500,
              fontSize: 30,
              letterSpacing: -0.6,
              color: textHi,
            }}
          >
            Oh My OpenAgent
          </div>
          <div
            style={{
              display: "flex",
              fontFamily: "Geist Mono",
              fontSize: 15,
              letterSpacing: 3.2,
              color: textLo,
            }}
          >
            THE AGENT HARNESS · OPENCODE · CODEX · SENPI
          </div>
        </div>
      </div>

      <div style={{ position: "absolute", top: 196, left: 72, display: "flex" }}>
        <OgTagline text={stats.description} />
      </div>

      <div style={{ position: "absolute", top: 150, right: 60, display: "flex" }}>
        <GraphGlyph />
      </div>
      <div
        style={{
          position: "absolute",
          top: 176,
          right: 44,
          display: "flex",
          flexDirection: "column",
          gap: 116,
          fontFamily: "Geist Mono",
          fontSize: 14,
          letterSpacing: 2,
          color: textFaint,
        }}
      >
        <div style={{ display: "flex" }}>01</div>
        <div style={{ display: "flex" }}>02</div>
        <div style={{ display: "flex" }}>03</div>
      </div>

      <div
        style={{
          position: "absolute",
          left: 72,
          right: 72,
          bottom: 52,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          fontFamily: "Geist Mono",
          fontSize: 26,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 28 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12, color: accent }}>
            <svg width="26" height="26" viewBox="0 0 24 24" fill={accent} aria-hidden="true">
              <path d="m12 1 3.4 6.9 7.6 1.1-5.5 5.4 1.3 7.6-6.8-3.6L5.2 22l1.3-7.6L1 9l7.6-1.1Z" />
            </svg>
            {stats.stars} stars
          </div>
          <div style={{ display: "flex", color: textLo }}>{stats.totalDownloads} downloads</div>
        </div>
        <div style={{ display: "flex", color: textMid }}>omo.dev</div>
      </div>
    </div>,
    {
      ...size,
      fonts: [
        { name: "Geist", data: decodeFont(geistMediumBase64), weight: 500, style: "normal" },
        {
          name: "Geist Mono",
          data: decodeFont(geistMonoRegularBase64),
          weight: 400,
          style: "normal",
        },
      ],
      headers: {
        "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=86400",
      },
    },
  )
}

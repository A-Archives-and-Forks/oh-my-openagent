"use client"

import type { CSSProperties, JSX } from "react"
import { useEffect, useRef, useState } from "react"

import { cn } from "@/lib/utils"

export interface LitTextProps {
  readonly text: string
  readonly className?: string
}

const THRESHOLDS = Array.from({ length: 201 }, (_, i) => i / 200)

function supportsScrollTimeline(): boolean {
  return typeof CSS !== "undefined" && CSS.supports("animation-timeline: view()")
}

/**
 * Words light up as a continuous sweep while the paragraph scrolls from the viewport bottom
 * to its upper third (DESIGN.md §10 lit text). One progress value, `--lit-p` (0 → 1), drives
 * every word: browsers with scroll-driven animations animate it in CSS (`.lit-scroll`), the
 * rest get it from an IntersectionObserver sampled at 200 thresholds. Each word maps the
 * shared progress to its own fill and paints it as a gradient across its glyphs, so the
 * light travels inside words and across neighbours instead of flipping word by word.
 */
export function LitText({ text, className }: LitTextProps): JSX.Element {
  const ref = useRef<HTMLParagraphElement>(null)
  const words = text.split(/(\s+)/)
  const wordCount = words.filter((w) => w.trim()).length
  const [mode, setMode] = useState<"pending" | "scroll" | "observer">("pending")
  const [progress, setProgress] = useState(0)

  useEffect(() => {
    const element = ref.current
    if (!element) return
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setMode("observer")
      setProgress(1)
      return
    }
    if (supportsScrollTimeline()) {
      setMode("scroll")
      return
    }
    setMode("observer")
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry) return
        const viewport = entry.rootBounds?.height ?? window.innerHeight
        const start = viewport
        const end = viewport * 0.35
        const next = Math.min(
          1,
          Math.max(0, (start - entry.boundingClientRect.top) / (start - end)),
        )
        setProgress((current) => Math.max(current, next))
      },
      { threshold: THRESHOLDS, rootMargin: "0px 0px -35% 0px" },
    )
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const style: CSSProperties & { "--lit-count": number; "--lit-p"?: number } = {
    "--lit-count": wordCount,
  }
  if (mode === "observer") style["--lit-p"] = progress

  let index = 0
  return (
    <p
      ref={ref}
      className={cn("lit-text", mode === "scroll" && "lit-scroll", className)}
      style={style}
    >
      {words.map((word, i) => {
        if (!word.trim()) return word
        const wordStyle: CSSProperties & { "--i": number } = { "--i": index }
        index += 1
        return (
          <span key={i} className="lit-word" style={wordStyle}>
            {word}
          </span>
        )
      })}
    </p>
  )
}

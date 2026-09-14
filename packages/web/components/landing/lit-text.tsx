"use client"

import type { CSSProperties, JSX, ReactNode } from "react"
import { useEffect, useRef, useState } from "react"

import { cn } from "@/lib/utils"

const THRESHOLDS = Array.from({ length: 201 }, (_, i) => i / 200)

function registerLitProgress(): boolean {
  if (typeof CSS === "undefined" || !("registerProperty" in CSS)) return false
  try {
    CSS.registerProperty({
      name: "--lit-p",
      syntax: "<number>",
      inherits: true,
      initialValue: "0",
    })
    return true
  } catch (error) {
    return error instanceof DOMException && error.name === "InvalidModificationError"
  }
}

function supportsScrollTimeline(): boolean {
  return CSS.supports("animation-timeline: view()")
}

export interface LitProgressProps {
  readonly children: ReactNode
  readonly className?: string
}

/**
 * Owns the shared scroll progress `--lit-p` (0 → 1) for everything inside it (DESIGN.md §10
 * lit text): after JS registers the interpolated property, browsers with an active scroll-driven
 * animation animate it in CSS (`.lit-scroll`) from the block's top 20vh above the viewport bottom
 * until the block's bottom reaches mid-viewport; the rest get the same range from an IntersectionObserver sampled
 * at 200 thresholds. `LitWords` and the follow-up line read the
 * inherited value, so the words sweep and the line appears from one timeline.
 */
export function LitProgress({ children, className }: LitProgressProps): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
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
    const useTimeline = registerLitProgress() && supportsScrollTimeline()

    const updateProgress = (entry?: IntersectionObserverEntry) => {
      const rect = entry?.boundingClientRect ?? element.getBoundingClientRect()
      const viewport = entry?.rootBounds?.height ?? window.innerHeight
      const startTop = viewport * 0.8
      const endTop = viewport * 0.5 - rect.height
      const span = startTop - endTop
      const next = span > 0 ? (startTop - rect.top) / span : rect.top <= endTop ? 1 : 0
      setProgress(Math.min(1, Math.max(0, next)))
    }
    const observer = new IntersectionObserver(([entry]) => updateProgress(entry), {
      threshold: THRESHOLDS,
    })
    const useObserver = () => {
      element.classList.remove("lit-scroll")
      setMode("observer")
      updateProgress()
      observer.observe(element)
    }
    let frame = 0
    if (useTimeline) {
      element.classList.add("lit-scroll")
      const animation = element
        .getAnimations()
        .find((item) => item instanceof CSSAnimation && item.animationName === "lit-progress")
      // View timelines acquire their current time during the next rendering update.
      frame = requestAnimationFrame(() => {
        const timeline = animation?.timeline
        if (timeline && timeline !== document.timeline && timeline.currentTime !== null) {
          setMode("scroll")
        } else {
          useObserver()
        }
      })
    } else {
      useObserver()
    }
    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
      element.classList.remove("lit-scroll")
    }
  }, [])

  const style: CSSProperties & { "--lit-p"?: number } = {}
  if (mode === "observer") style["--lit-p"] = progress

  return (
    <div
      ref={ref}
      className={cn("lit-progress", mode === "scroll" && "lit-scroll", className)}
      style={style}
    >
      {children}
    </div>
  )
}

export interface LitWordsProps {
  readonly text: string
  readonly className?: string
}

export function LitWords({ text, className }: LitWordsProps): JSX.Element {
  const words = text.split(/(\s+)/)
  const wordCount = words.filter((w) => w.trim()).length
  const style: CSSProperties & { "--lit-count": number } = { "--lit-count": wordCount }

  let index = 0
  return (
    <p className={cn("lit-text", className)} style={style}>
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

"use client"

import { useEffect, useRef, useState } from "react"

const TYPE_MS = 40
const WAVE_GAP_MS = 900
const WAVE_BUSY_MS = 650
const VERIFY_DELAY_MS = 300
const FLASH_MS = 600

export type WaveStatus = "pending" | "busy" | "ok"

export interface TerminalFrame {
  /** Characters of the prompt typed so far. */
  readonly typed: string
  readonly waves: readonly WaveStatus[]
  /** `off` → `flash` (accent-hot) → `settled` (text-hi). */
  readonly verified: "off" | "flash" | "settled"
}

function finalFrame(prompt: string, waveCount: number): TerminalFrame {
  return {
    typed: prompt,
    waves: Array.from({ length: waveCount }, (): WaveStatus => "ok"),
    verified: "settled",
  }
}

function idleFrame(waveCount: number): TerminalFrame {
  return {
    typed: "",
    waves: Array.from({ length: waveCount }, (): WaveStatus => "pending"),
    verified: "off",
  }
}

interface Step {
  readonly at: number
  readonly apply: (frame: TerminalFrame) => TerminalFrame
}

function buildTimeline(prompt: string, waveCount: number): readonly Step[] {
  const steps: Step[] = []
  for (let i = 1; i <= prompt.length; i++) {
    steps.push({ at: i * TYPE_MS, apply: (frame) => ({ ...frame, typed: prompt.slice(0, i) }) })
  }
  const typed = prompt.length * TYPE_MS + 400
  const setWave = (index: number, status: WaveStatus) => (frame: TerminalFrame) => ({
    ...frame,
    waves: frame.waves.map((current, i) => (i === index ? status : current)),
  })
  for (let i = 0; i < waveCount; i++) {
    const start = typed + i * WAVE_GAP_MS
    steps.push({ at: start, apply: setWave(i, "busy") })
    steps.push({ at: start + WAVE_BUSY_MS, apply: setWave(i, "ok") })
  }
  const done = typed + (waveCount - 1) * WAVE_GAP_MS + WAVE_BUSY_MS + VERIFY_DELAY_MS
  steps.push({ at: done, apply: (frame) => ({ ...frame, verified: "flash" }) })
  steps.push({ at: done + FLASH_MS, apply: (frame) => ({ ...frame, verified: "settled" }) })
  return steps
}

/**
 * DESIGN.md §5 Terminal playback: gated by an IntersectionObserver at 40% visible, types the
 * prompt at 40ms/char (`--dur-type`), then lights waves busy → ok one by one and flashes
 * `verified`. Runs once. Reduced motion renders the final frame immediately.
 */
export function useTerminalPlayback(
  prompt: string,
  waveCount: number,
): { ref: (node: HTMLElement | null) => void; frame: TerminalFrame } {
  const nodeRef = useRef<HTMLElement | null>(null)
  const [started, setStarted] = useState(false)
  const [frame, setFrame] = useState<TerminalFrame>(() => idleFrame(waveCount))

  useEffect(() => {
    const node = nodeRef.current
    if (!node || started) return
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setStarted(true)
      setFrame(finalFrame(prompt, waveCount))
      return
    }
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting) return
        setStarted(true)
        observer.disconnect()
      },
      { threshold: 0.4 },
    )
    observer.observe(node)
    return () => observer.disconnect()
  }, [started, prompt, waveCount])

  useEffect(() => {
    if (!started || matchMedia("(prefers-reduced-motion: reduce)").matches) return
    const timers = buildTimeline(prompt, waveCount).map((step) =>
      window.setTimeout(() => setFrame(step.apply), step.at),
    )
    return () => {
      for (const timer of timers) window.clearTimeout(timer)
    }
  }, [started, prompt, waveCount])

  return {
    ref: (node) => {
      nodeRef.current = node
    },
    frame,
  }
}

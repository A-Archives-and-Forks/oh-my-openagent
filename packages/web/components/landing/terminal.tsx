"use client"

import type { JSX } from "react"

import { useGraphFocus } from "@/components/landing/graph/use-graph-focus"
import { useTerminalPlayback, type WaveStatus } from "@/components/landing/use-terminal-playback"
import { cn } from "@/lib/utils"

export interface TerminalWave {
  /** Wave number as shown ("1", "2", "3"). */
  readonly index: string
  readonly label: string
  readonly agents: string
  readonly task: string
  /** Graph node highlighted when the row is clicked. */
  readonly nodeId: string
}

export interface TerminalProps {
  readonly title: string
  readonly prompt: string
  readonly sidebarLabel: string
  readonly waves: readonly TerminalWave[]
  readonly verifiedLabel: string
  readonly className?: string
}

const DOT: Record<WaveStatus, string> = {
  pending: "bg-text-faint",
  busy: "bg-status-busy pulse-dot",
  ok: "bg-status-ok",
}

function StatusDot({ status }: { readonly status: WaveStatus }): JSX.Element {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "ease-standard size-2 shrink-0 rounded-full transition-colors duration-[var(--dur-micro)]",
        DOT[status],
      )}
    />
  )
}

/**
 * DESIGN.md §5 Terminal: HTML/CSS. Chrome bar `--ink-2` with three `--text-faint` dots and a
 * mono title; `--ink-3` wave sidebar at ≥ md; body `--code-bg` mono 13px `--code-fg`.
 * Clicking a wave row focuses that wave's first node in the hero graph (shared store).
 */
export function Terminal({
  title,
  prompt,
  sidebarLabel,
  waves,
  verifiedLabel,
  className,
}: TerminalProps): JSX.Element {
  const { ref, frame } = useTerminalPlayback(prompt, waves.length)
  const { focusedId, setFocused } = useGraphFocus()
  const typing = frame.typed.length < prompt.length

  return (
    <div
      ref={ref}
      data-testid="terminal"
      className={cn("border-line grid grid-rows-[auto_1fr] border", className)}
    >
      <div className="bg-ink-2 border-line flex h-10 items-center gap-2 border-b px-4">
        <span aria-hidden="true" className="flex gap-1.5">
          <span className="bg-text-faint size-2 rounded-full" />
          <span className="bg-text-faint size-2 rounded-full" />
          <span className="bg-text-faint size-2 rounded-full" />
        </span>
        <span className="text-text-lo text-meta tracking-meta ml-2 truncate font-mono">
          {title}
        </span>
      </div>
      <div className="grid md:grid-cols-[10rem_1fr]">
        <aside className="bg-ink-3 border-line hidden border-r p-4 md:block">
          <p className="eyebrow">{sidebarLabel}</p>
          <ol className="mt-4 space-y-3">
            {waves.map((wave, i) => (
              <li key={wave.index} className="text-meta flex items-center gap-2 font-mono">
                <StatusDot status={frame.waves[i] ?? "pending"} />
                <span className="text-text-faint tabular-nums">0{wave.index}</span>
                <span className="text-text-mid truncate">{wave.label}</span>
              </li>
            ))}
          </ol>
        </aside>
        <div className="bg-code-bg text-code-fg min-h-64 p-4 font-mono text-[13px] leading-[1.55] sm:p-6">
          <p className="flex items-baseline gap-2 whitespace-pre-wrap">
            <span aria-hidden="true" className="text-accent">
              $
            </span>
            <span className="text-text-hi">
              {frame.typed}
              {typing ? (
                <span
                  aria-hidden="true"
                  className="bg-accent-hot cursor-blink ml-px inline-block h-[1em] w-[0.6ch] translate-y-[0.15em]"
                />
              ) : null}
            </span>
          </p>
          <ol className="mt-4 space-y-px">
            {waves.map((wave, i) => {
              const status = frame.waves[i] ?? "pending"
              const active = wave.nodeId === focusedId
              return (
                <li key={wave.index}>
                  <button
                    type="button"
                    onClick={() => setFocused(active ? null : wave.nodeId)}
                    aria-pressed={active}
                    data-active={active ? "true" : undefined}
                    className={cn(
                      "hover:bg-accent-4 data-[active=true]:bg-accent-8 ease-standard focus-visible:outline-accent-32 grid min-h-11 w-full grid-cols-[auto_5rem_1fr] items-center gap-x-3 px-2 text-left transition-[opacity,background-color] duration-[var(--dur-micro)] focus-visible:outline-2 focus-visible:-outline-offset-2 sm:grid-cols-[auto_5rem_1fr_1fr]",
                      status === "pending" ? "opacity-0" : "opacity-100",
                    )}
                  >
                    <StatusDot status={status} />
                    <span className="text-text-lo">{wave.label}</span>
                    <span className={cn("truncate", active ? "text-accent" : "text-code-fg")}>
                      {wave.agents}
                    </span>
                    <span className="text-text-lo hidden truncate sm:inline">{wave.task}</span>
                  </button>
                </li>
              )
            })}
          </ol>
          <p
            className={cn(
              "ease-standard mt-4 flex items-center gap-2 transition-[opacity,color] duration-[var(--dur-reveal)]",
              frame.verified === "off" ? "opacity-0" : "opacity-100",
              frame.verified === "flash" ? "text-accent-hot" : "text-text-hi",
            )}
          >
            <StatusDot status="ok" />
            {verifiedLabel}
          </p>
          {!typing && frame.verified === "settled" ? (
            <p className="mt-4 flex items-baseline gap-2">
              <span aria-hidden="true" className="text-accent">
                $
              </span>
              <span
                aria-hidden="true"
                className="bg-accent-hot cursor-blink inline-block h-[1em] w-[0.6ch] translate-y-[0.15em]"
              />
            </p>
          ) : null}
        </div>
      </div>
    </div>
  )
}

import type { JSX } from "react"
import { getTranslations } from "next-intl/server"

import { SectionHeader } from "@/components/landing/section-header"
import { Terminal, type TerminalWave } from "@/components/landing/terminal"
import { graphWaves } from "@/components/landing/agents-data"
import { Reveal } from "@/components/landing/motion-wrappers"
import { Frame } from "@/components/ledger/frame"

/** `sticky-aside` (DESIGN.md §0 StyleGallery): sticky title column beside the terminal. */
export async function MassUlwSection(): Promise<JSX.Element> {
  const t = await getTranslations("landing")

  const waves: readonly TerminalWave[] = graphWaves.map((wave) => ({
    index: String(wave.wave),
    label: t(`ulw.waves.${wave.wave}.label`),
    agents: t(`ulw.waves.${wave.wave}.agents`),
    task: t(`ulw.waves.${wave.wave}.task`),
    nodeId: wave.firstNodeId,
  }))

  return (
    <section
      data-section="mass-ulw"
      aria-labelledby="mass-title"
      className="border-line border-t py-16 lg:py-24"
    >
      <Frame>
        <div className="grid gap-10 lg:grid-cols-[minmax(0,22rem)_1fr] lg:gap-6">
          <Reveal className="lg:sticky lg:top-24 lg:self-start">
            <SectionHeader
              id="mass-title"
              eyebrow={t("ulw.eyebrow")}
              dot="busy"
              title={t("ulw.title")}
              intro={t("ulw.description")}
            />
          </Reveal>
          <Reveal index={1}>
            <Terminal
              title={t("ulw.terminalTitle")}
              prompt={t("ulw.terminalInput")}
              sidebarLabel={t("ulw.sidebarLabel")}
              waves={waves}
              verifiedLabel={t("ulw.verified")}
            />
          </Reveal>
        </div>
      </Frame>
    </section>
  )
}

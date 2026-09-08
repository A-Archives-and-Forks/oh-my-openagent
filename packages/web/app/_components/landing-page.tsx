import type { Metadata } from "next"
import type { JSX } from "react"
import { ArchitectureSection } from "@/components/landing/sections/architecture"
import { CtaSection } from "@/components/landing/sections/cta"
import { EditionsSection } from "@/components/landing/sections/editions"
import { HephaestusSection } from "@/components/landing/sections/hephaestus"
import { HeroSection } from "@/components/landing/sections/hero"
import { PrometheusAtlasSection } from "@/components/landing/sections/prometheus-atlas"
import { ReviewsSection } from "@/components/landing/sections/reviews"
import { SisyphusSection } from "@/components/landing/sections/sisyphus"
import { SubAgentsSection } from "@/components/landing/sections/sub-agents"
import { TeamModeSection } from "@/components/landing/sections/team-mode"
import { UltraworkSection } from "@/components/landing/sections/ultrawork"
import { getStats, FALLBACK_DESCRIPTION } from "@/lib/stats"

export async function generateLandingMetadata(): Promise<Metadata> {
  let description = FALLBACK_DESCRIPTION
  try {
    description = (await getStats()).description
  } catch (error) {
    console.warn("Unable to refresh landing metadata; using fallback description", error)
  }

  return {
    title: "Oh My OpenAgent — The Best Agent Harness",
    description,
  }
}

export async function LandingPage(): Promise<JSX.Element> {
  return (
    <div className="flex min-h-screen flex-col overflow-x-hidden">
      <link rel="preload" as="image" href="/images/hero.webp" fetchPriority="low" />
      <HeroSection />
      <UltraworkSection />
      <EditionsSection />
      <SisyphusSection />
      <PrometheusAtlasSection />
      <HephaestusSection />
      <TeamModeSection />
      <SubAgentsSection />
      <ArchitectureSection />
      <ReviewsSection />
      <CtaSection />
    </div>
  )
}

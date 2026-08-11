import { execFileSync } from "node:child_process"
import { join } from "node:path"

import type { ExtensionContext, SessionStartEvent } from "@code-yeongyu/senpi"

import type { ComponentContext, OmoSenpiComponent, SenpiExtensionAPI } from "../../extension/types"
import {
  isExtensionContext,
  isSessionStartEvent,
} from "../onboarding/component"
import { getOnboardingMarkerMtime } from "../onboarding/state"
import { getBuiltinSkillsRoot, getOmoNativeStateDir } from "../telemetry/product-identity"
import { computeEligibility } from "./eligibility"
import { gitHead, gitIsRepo } from "./git-helpers"
import { buildProposedData } from "./proposed-data"
import type { EligibilityResult, SuggestedMode } from "./proposed-data"
import * as advisorState from "./state"

const CHOICES = [
  "Run now",
  "Skip for now",
  "Never in this project",
  "Never anywhere",
]

export const processStartTime: number = Date.now()

export function createInitDeepAdvisorComponent(): OmoSenpiComponent {
  return {
    name: "init-deep-advisor",
    register(pi: SenpiExtensionAPI, ctx: ComponentContext): void {
      pi.on("session_start", (rawPayload: unknown, rawEventCtx: unknown) => {
        if (!isSessionStartEvent(rawPayload)) return
        const payload: SessionStartEvent = rawPayload
        if (payload.reason !== "startup") return
        if (!isExtensionContext(rawEventCtx)) return
        const eventCtx: ExtensionContext = rawEventCtx
        void runAdvisor(pi, ctx, eventCtx).catch((error) => {
          ctx.logger.warn("init-deep-advisor failed", { error })
        })
      })
    },
  }
}

export async function runAdvisor(
  pi: SenpiExtensionAPI,
  ctx: ComponentContext,
  eventCtx: ExtensionContext,
): Promise<void> {
  if (!eventCtx.hasUI) return
  if (pi.getFlag("omo-senpi-init-deep-advisor-disabled") === true) return
  const onboardingStateDir = getOmoNativeStateDir(process.env)
  const advisorStateDir = join(getOmoNativeStateDir(process.env), "init-deep-advisor-state")
  const cwd = eventCtx.cwd ?? process.cwd()
  if (!gitIsRepo(cwd)) return
  const root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
    cwd,
    encoding: "utf8",
  }).trim()
  const markerMtime = getOnboardingMarkerMtime(onboardingStateDir)
  if (markerMtime === null || markerMtime >= processStartTime) return
  const repo = advisorState.repoHash(root)
  if (advisorState.isGloballyDeclined(advisorStateDir)) return
  if (advisorState.isProjectDeclined(advisorStateDir, repo)) return
  const cooldownUntil = advisorState.readCooldownUntil(advisorStateDir, repo)
  if (Date.now() < cooldownUntil) return
  const currentHead = gitHead(root)
  const eligibility = computeEligibility(
    root,
    currentHead,
    advisorState.readLastProposedHead(advisorStateDir, repo),
    cooldownUntil,
  )
  if (eligibility === null) return
  advisorState.writeLastProposedHead(advisorStateDir, repo, currentHead)
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
  const choice = await eventCtx.ui?.select("Init-deep", [...CHOICES], { timeout: 60_000 })
  handleChoice(choice, pi, advisorStateDir, repo, root, eligibility)
}

function handleChoice(
  choice: string | undefined,
  pi: SenpiExtensionAPI,
  stateDir: string,
  repo: string,
  root: string,
  eligibility: EligibilityResult,
): void {
  if (choice === "Run now") {
    const skillsRoot = getBuiltinSkillsRoot()
    pi.sendMessage(
      {
        customType: "omo-init-deep-advisor:run",
        content: `Read the init-deep skill at ${skillsRoot}/init-deep/SKILL.md with the read tool and follow it.`,
        display: false,
      },
      { triggerTurn: true, deliverAs: "followUp" },
    )
    const proposedData = buildProposedData(repo, eligibility, suggestedMode(root))
    pi.appendEntry?.("omo-init-deep-advisor:proposed", proposedData)
    return
  }
  if (choice === "Skip for now") {
    advisorState.writeCooldown(stateDir, repo, Date.now())
    return
  }
  if (choice === "Never in this project") {
    advisorState.writeProjectDecline(stateDir, repo)
    return
  }
  if (choice === "Never anywhere") advisorState.writeGlobalDecline(stateDir)
}

function suggestedMode(root: string): SuggestedMode {
  try {
    execFileSync("git", ["ls-files", "--error-unmatch", "AGENTS.md"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
    return "committed"
  } catch {
    return "local"
  }
}

import type { InstallConfig } from "./types"

export const SENPI_EDITION_INSTALL_COMMAND = "bun add -g omo-ai@beta"
export const SENPI_EDITION_GUIDE_URL =
  "https://github.com/code-yeongyu/oh-my-openagent/blob/dev/docs/guide/installation.md#senpi-edition-beta-omo-via-omo-ai"
export const SENPI_EDITION_HINT_TITLE = "Standalone Senpi edition (beta)"

export type SenpiEditionHintPaint = {
  readonly command: (text: string) => string
  readonly link: (text: string) => string
}

const PLAIN_PAINT: SenpiEditionHintPaint = {
  command: (text) => text,
  link: (text) => text,
}

export function shouldShowSenpiEditionHint(config: Pick<InstallConfig, "hasSenpi">): boolean {
  return !config.hasSenpi
}

export function senpiEditionHintLines(paint: SenpiEditionHintPaint = PLAIN_PAINT): readonly string[] {
  return [
    `omo also ships as a standalone Senpi edition: one ${paint.command("omo")} command, no OpenCode host required.`,
    `Try it next to this install: ${paint.command(SENPI_EDITION_INSTALL_COMMAND)}, then run ${paint.command("omo")}.`,
    "This install keeps working as-is.",
    `Guide: ${paint.link(SENPI_EDITION_GUIDE_URL)}`,
  ]
}

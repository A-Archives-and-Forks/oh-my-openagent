import { describe, expect, it } from "bun:test"
import {
  SENPI_EDITION_GUIDE_URL,
  SENPI_EDITION_INSTALL_COMMAND,
  senpiEditionHintLines,
  shouldShowSenpiEditionHint,
} from "./senpi-edition-hint"

describe("senpiEditionHintLines", () => {
  it("names the install command and the guide link", () => {
    // given / when
    const text = senpiEditionHintLines().join("\n")

    // then
    expect(text).toContain(SENPI_EDITION_INSTALL_COMMAND)
    expect(text).toContain(SENPI_EDITION_GUIDE_URL)
  })

  it("routes the command and the link through the caller's paint", () => {
    // given
    const paint = {
      command: (value: string) => `<cmd>${value}</cmd>`,
      link: (value: string) => `<link>${value}</link>`,
    }

    // when
    const text = senpiEditionHintLines(paint).join("\n")

    // then
    expect(text).toContain(`<cmd>${SENPI_EDITION_INSTALL_COMMAND}</cmd>`)
    expect(text).toContain(`<link>${SENPI_EDITION_GUIDE_URL}</link>`)
  })
})

describe("shouldShowSenpiEditionHint", () => {
  it("shows the hint for an OpenCode-edition install", () => {
    expect(shouldShowSenpiEditionHint({ hasSenpi: false })).toBe(true)
  })

  it("hides the hint when the install target is the senpi platform itself", () => {
    expect(shouldShowSenpiEditionHint({ hasSenpi: true })).toBe(false)
  })
})

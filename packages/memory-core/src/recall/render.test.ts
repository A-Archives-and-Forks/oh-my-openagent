import { describe, expect, it } from "bun:test"
import type { RecallCandidate } from "./select"
import { renderRecallMessage } from "./render"

function candidate(path: string, description: string, excerpt: string): RecallCandidate {
  return { path, description, excerpt, score: 12 }
}

describe("renderRecallMessage", () => {
  it("#given no candidates #when the message is rendered #then the result is empty", () => {
    // given / when
    const message = renderRecallMessage([])
    // then
    expect(message).toBe("")
  })

  it("#given one candidate #when the message is rendered #then the exact block shape is produced", () => {
    // given
    const candidates = [candidate("reference/a.md", "Deploy", "the ingress gateway is flaky")]

    // when
    const message = renderRecallMessage(candidates)

    // then
    expect(message).toBe(
      "<recalled-memory>\n" +
        "A stored memory surfaced. It is a hint, not current state — verify before relying on it; read the source path for full context.\n" +
        '- [[reference/a.md]] — Deploy · "the ingress gateway is flaky"\n' +
        "</recalled-memory>",
    )
  })

  it("#given several candidates #when the message is rendered #then one bullet per candidate keeps order", () => {
    // given
    const candidates = [
      candidate("notes/b.md", "Kubernetes notes", "first"),
      candidate("people/alice.md", "Alice the backend lead", "second"),
    ]

    // when
    const message = renderRecallMessage(candidates)

    // then
    const lines = message.split("\n")
    expect(lines).toHaveLength(5)
    expect(lines[0]).toBe("<recalled-memory>")
    expect(lines[1]).toBe(
      "A stored memory surfaced. It is a hint, not current state — verify before relying on it; read the source path for full context.",
    )
    expect(lines[2]).toBe('- [[notes/b.md]] — Kubernetes notes · "first"')
    expect(lines[3]).toBe('- [[people/alice.md]] — Alice the backend lead · "second"')
    expect(lines[4]).toBe("</recalled-memory>")
  })

  it("#given a rendered message #when the shape is inspected #then no trailing newline is appended", () => {
    // given
    const candidates = [candidate("reference/a.md", "Deploy", "excerpt")]

    // when
    const message = renderRecallMessage(candidates)

    // then
    expect(message.endsWith("\n")).toBe(false)
  })
})

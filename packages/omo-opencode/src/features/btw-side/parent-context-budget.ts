import type { Message, Part } from "@opencode-ai/sdk"

export const BTW_PARENT_CONTEXT_MAX_BYTES = 64 * 1024
export const BTW_PARENT_CONTEXT_MAX_MESSAGES = 64

type MessageWithParts = {
  info: Message
  parts: Part[]
}

const encoder = new TextEncoder()

function serializedBytes(messages: MessageWithParts[]): number {
  return encoder.encode(JSON.stringify(messages)).byteLength
}

function cloneMessage(message: MessageWithParts): MessageWithParts {
  return {
    info: { ...message.info },
    parts: message.parts.map((part) => ({ ...part })),
  }
}

function truncatedMessage(
  message: MessageWithParts,
  maxBytes: number,
): MessageWithParts {
  const sourceText = message.parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n")
  const marker = "[Earlier parent message content truncated]\n"
  const createCandidate = (tailCharacters: number): MessageWithParts => ({
    info: { ...message.info },
    parts: [
      {
        id: `${message.info.id}_btw_truncated`,
        messageID: message.info.id,
        sessionID: message.info.sessionID,
        type: "text",
        text: `${marker}${sourceText.slice(-tailCharacters)}`,
        synthetic: true,
      },
    ],
  })

  let best: MessageWithParts = {
    info: { ...message.info },
    parts: [],
  }
  let low = 0
  let high = sourceText.length
  while (low <= high) {
    const middle = Math.floor((low + high) / 2)
    const candidate = createCandidate(middle)
    if (serializedBytes([candidate]) <= maxBytes) {
      best = candidate
      low = middle + 1
    } else {
      high = middle - 1
    }
  }
  return best
}

export function boundBtwParentContext(
  messages: MessageWithParts[],
): MessageWithParts[] {
  const candidates = messages.slice(-BTW_PARENT_CONTEXT_MAX_MESSAGES)
  const bounded: MessageWithParts[] = []

  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const message = cloneMessage(candidates[index])
    if (
      serializedBytes([message, ...bounded]) <=
      BTW_PARENT_CONTEXT_MAX_BYTES
    ) {
      bounded.unshift(message)
      continue
    }
    if (bounded.length === 0) {
      bounded.unshift(
        truncatedMessage(message, BTW_PARENT_CONTEXT_MAX_BYTES),
      )
    }
    break
  }

  return bounded
}

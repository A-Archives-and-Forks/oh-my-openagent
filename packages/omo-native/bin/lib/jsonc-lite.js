export function parseJsoncLite(text) {
  const stripped = stripCommentsAndTrailingCommas(text.replace(/^﻿/, ""))
  return JSON.parse(stripped)
}

function stripCommentsAndTrailingCommas(input) {
  let out = ""
  let i = 0
  let inString = false
  while (i < input.length) {
    const ch = input[i]
    if (inString) {
      out += ch
      if (ch === "\\") {
        out += input[i + 1] ?? ""
        i += 2
        continue
      }
      if (ch === '"') inString = false
      i += 1
      continue
    }
    if (ch === '"') {
      inString = true
      out += ch
      i += 1
      continue
    }
    if (ch === "/" && input[i + 1] === "/") {
      while (i < input.length && input[i] !== "\n") i += 1
      continue
    }
    if (ch === "/" && input[i + 1] === "*") {
      i += 2
      while (i < input.length && !(input[i] === "*" && input[i + 1] === "/")) i += 1
      i += 2
      continue
    }
    if ((ch === "," )) {
      let j = i + 1
      for (;;) {
        while (j < input.length && /\s/.test(input[j])) j += 1
        if (input[j] === "/" && input[j + 1] === "/") {
          while (j < input.length && input[j] !== "\n") j += 1
          continue
        }
        if (input[j] === "/" && input[j + 1] === "*") {
          j += 2
          while (j < input.length && !(input[j] === "*" && input[j + 1] === "/")) j += 1
          j += 2
          continue
        }
        break
      }
      if (input[j] === "}" || input[j] === "]") {
        i += 1
        continue
      }
    }
    out += ch
    i += 1
  }
  return out
}

import type { Message, ModelAdapter, ModelRequest, ModelResponse } from "../model/types"

/** A fake model that replies from a script; each step sees the requests it was sent so far. */
export function scriptedModel(
  script: Array<(request: ModelRequest) => ModelResponse | Promise<ModelResponse>>,
): ModelAdapter & { requests: ModelRequest[] } {
  const requests: ModelRequest[] = []
  return {
    name: "scripted",
    requests,
    async complete(request) {
      requests.push(structuredClone({ ...request, signal: undefined }))
      const next = script[requests.length - 1]
      if (!next) throw new Error(`scripted model has no reply for call ${requests.length}`)
      return next(request)
    },
  }
}

export function lastToolText(messages: Message[]): string {
  const last = messages.findLast((message) => message.role === "tool")
  if (last?.role !== "tool") return ""
  return last.content.map((part) => (part.type === "text" ? part.text : "")).join("\n")
}

/**
 * The current page as the model can read it from `messages`: the newest snapshot, or the newest snapshot changes
 * applied to the full snapshot before them. Throws when the changes do not apply to it line by line.
 */
export function currentPage(messages: Message[]): string {
  const snapshots = messages.flatMap((message) => {
    const part = message.role === "tool" ? message.content[1] : message.role === "user" ? message.content[0] : undefined
    const text = part?.type === "text" ? part.text : ""
    return message.role === "tool" ? [text] : text.includes("\n\nCurrent page:\n") ? [text.split("\n\nCurrent page:\n")[1]!] : []
  })
  const newest = snapshots.findLast((text) => text.startsWith("Page URL: ") || text.includes("\nSnapshot changes:\n"))
  if (!newest?.includes("\nSnapshot changes:\n")) return newest ?? ""
  const base = snapshots.findLast((text) => text.startsWith("Page URL: "))
  if (!base) throw new Error("No full snapshot before the snapshot changes")
  const page = newest.slice(newest.indexOf("\nPage URL: ") + 1, newest.indexOf("Snapshot changes:\n"))
  const changes = newest.slice(newest.indexOf("Snapshot changes:\n") + "Snapshot changes:\n".length)
  const lines = base.slice(base.indexOf("\nSnapshot:\n") + "\nSnapshot:\n".length).split("\n")
  const tree: string[] = []
  let at = 0
  // Between "…" marks, the kept and removed lines are consecutive lines of the full snapshot: right where the last part
  // ended, or at their first place after the lines that "…" skips.
  for (const [index, part] of (changes === "(none)" ? "" : changes).split(/^…$/m).entries()) {
    const marked = part.split("\n").filter(Boolean)
    const block = marked.filter((line) => !line.startsWith("+")).map((line) => line.slice(1))
    let found = at
    if (index > 0) while (found + block.length <= lines.length && !block.every((line, offset) => lines[found + offset] === line)) found++
    if (!block.every((line, offset) => lines[found + offset] === line)) throw new Error(`Snapshot changes do not apply after line ${at}: ${marked[0]}`)
    tree.push(...lines.slice(at, found))
    for (const line of marked) {
      if (!line.startsWith("-")) tree.push(line.slice(1))
      if (!line.startsWith("+")) found++
    }
    at = found
  }
  return `${page}Snapshot:\n${[...tree, ...lines.slice(at)].join("\n")}`
}

import type { ModelRequest } from "./model/types"

/**
 * The question a judge model answers about a final answer that claims success. A TypeSafe System One model takes it as
 * its yes/no question; a chat model also gets the reply format at the end of the request.
 */
export const JUDGE_PROMPT = `Is the web agent's answer to the task supported by the page evidence?
- Supported: the names, numbers, counts and dates the answer states agree with the evidence, and the answer does what the task asked.
- Not supported: the evidence contradicts the answer, or shows that the answer misses or misreads what the task asked.
- The evidence is the page content the agent saw last, possibly cut to an excerpt. A fact it does not mention may come from an earlier page and does not count against the answer.`

/** At or below this probability of support, the judge sends the answer back or marks it partial. Live A/B runs (#162) tune it. */
export const UNSUPPORTED_AT = 0.2

/** Evidence characters sent to the judge, shared by the newest page text and snapshot. */
const EVIDENCE_CHARS = 16_000

export interface Verdict {
  /** The judge's probability that the evidence supports the answer. */
  supported: number
  reason?: string
}

/** One tool-less request with the task, the answer, and the page content still in the agent's context. */
export function judgeRequest(task: string, answer: string, pages: { text?: string; snapshot?: string }): Omit<ModelRequest, "signal"> {
  const parts: Array<[string, string]> = []
  if (pages.text !== undefined) parts.push(["Text the agent read last", pages.text])
  // Refs and cursor hints only matter for acting on the page.
  if (pages.snapshot !== undefined) parts.push(["Latest page snapshot", pages.snapshot.replace(/ \[(?:ref|cursor)=[^\]]*\]/g, "")])
  const evidence = parts.map(([label, text]) => {
    const kept = relevantLines(text, `${task}\n${answer}`, Math.floor(EVIDENCE_CHARS / parts.length))
    return `${label}${kept === text ? "" : " (excerpt; … marks skipped lines)"}:\n${kept}`
  })
  const text = [
    `Task: ${task}`,
    `Answer: ${answer}`,
    ...(evidence.length ? evidence : ["Evidence: none; the agent opened no page."]),
    'Reply with only JSON: {"reason":"<one sentence>","supported":<probability from 0 to 1 that the answer is supported>}',
  ].join("\n\n")
  return { system: JUDGE_PROMPT, messages: [{ role: "user", content: [{ type: "text", text }] }], tools: [] }
}

/** The verdict in a judge's reply: JSON whose `supported` is a probability or a boolean, or a bare probability. */
export function parseVerdict(text = ""): Verdict | undefined {
  try {
    const parsed: unknown = JSON.parse(/\{[\s\S]*\}/.exec(text)?.[0] ?? text)
    const { supported, reason } = parsed !== null && typeof parsed === "object" ? parsed as Record<string, unknown> : { supported: parsed, reason: undefined }
    const probability = typeof supported === "boolean" ? Number(supported) : supported
    if (typeof probability !== "number" || !(probability >= 0 && probability <= 1)) return undefined
    return typeof reason === "string" && reason.trim() ? { supported: probability, reason: reason.trim() } : { supported: probability }
  } catch {
    return undefined
  }
}

/** Lowercased words cut to four letters, and numbers: rough terms that survive plurals and case. */
function terms(text: string): Set<string> {
  return new Set(text.toLowerCase().match(/\p{N}+|\p{L}{2,}/gu)?.map((term) => term.slice(0, 4)))
}

/**
 * Cut `text` to `max` characters, keeping the lines that share the most terms with `query` and the lines around them,
 * in page order. Terms on many lines, such as menu words, are ignored. Without any match the start of the text is kept.
 */
export function relevantLines(text: string, query: string, max: number): string {
  if (text.length <= max) return text
  const lines = text.split("\n")
  const lineTerms = lines.map(terms)
  const rare = [...terms(query)].filter((term) => lineTerms.filter((set) => set.has(term)).length <= Math.max(5, lines.length / 10))
  const hits = lineTerms.map((set) => rare.filter((term) => set.has(term)).length)
  // The neighbors of a strong match, such as the heading above a price, can matter more than a weak match elsewhere.
  const score = hits.map((hit, index) => 2 * hit + (hits[index - 1] ?? 0) + (hits[index + 1] ?? 0))
  const kept: number[] = []
  // Room for the closing marker; each line also reserves room for a marker before it.
  let size = 2
  for (const index of score.map((_, index) => index).filter((index) => score[index]! > 0).sort((a, b) => score[b]! - score[a]! || a - b)) {
    if (size + lines[index]!.length + 3 > max) continue
    kept.push(index)
    size += lines[index]!.length + 3
  }
  if (!kept.length) return `${text.slice(0, max - 1)}…`
  const out: string[] = []
  let previous = -1
  for (const index of kept.sort((a, b) => a - b)) {
    if (index > previous + 1) out.push("…")
    out.push(lines[index]!)
    previous = index
  }
  if (previous < lines.length - 1) out.push("…")
  return out.join("\n")
}

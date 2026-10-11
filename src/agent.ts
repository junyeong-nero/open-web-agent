import { createHash } from "node:crypto"
import { interruptible } from "./cancel"
import type { BrowserSession } from "./browser"
import { judgeRequest, matchingLines, parseVerdict, UNSUPPORTED_AT, withoutRefs } from "./judge"
import type { Message, ModelAdapter, ToolCall, Usage } from "./model/types"
import { type PageCheckCall, pageChecker } from "./page-check"
import { type BrowserTool, callTool, compactLine, resultContent, selectTools, type ToolResult, toolSpec } from "./tools"

export const SYSTEM_PROMPT = `You are a web agent that completes the user's task by operating a real browser through tools.

- Page state arrives as accessibility snapshots. Act on elements with their [ref=…] values from the most recent snapshot only; refs from older snapshots may be stale.
- Actions return a fresh snapshot, so you rarely need browser_snapshot right after acting.
- Prefer navigating directly to a URL when you know it. If a URL you guessed returns HTTP 404, stop guessing URLs on that site and use its links or search instead. Use browser_get_text to read long content.
- Only the newest snapshot and text read stay whole. Older ones from the last few pages are reduced to their task-relevant lines, without refs, and the rest are omitted. Before leaving a page whose facts you still need, read the relevant content with browser_get_text; keep any other needed facts in a brief assistant note.
- If an action fails, look at the new snapshot and try a different approach instead of repeating the same call.
- If a page's content, landing URL, or title indicates a bot check, CAPTCHA, or access denial (e.g. google.com/sorry or "Just a moment..."), or the server responds with HTTP 401, 402 or 403, or a result says HTTP 429 persisted after the automatic wait and reload, or a navigation returns a non-document file instead of a page, do not retry that site for the rest of this task, even with a different URL or query; use another site or search engine.
- After a site is blocked, do not keep rewriting search queries whose results point back to it: after three searches without opening a result, answer from what you have seen, with outcome blocked or partial.
- For lowest/highest/newest questions, use the site's sort or filter when available, otherwise compare every candidate you saw before answering.
- Never invent facts: base the answer on what you saw in the browser.
- When finished, reply without tool calls: write your user-facing answer first, then a final line containing only {"outcome":"succeeded|partial|blocked","unfinished":["any remaining work"]}. This is your own assessment, not independent verification. If you cannot complete the task, explain why in the answer and list the remaining work. That ends the run.`

export type AgentEvent =
  | { type: "step"; step: number }
  /** `role` is set on the judge's and the checker's calls; agent model calls leave it out. `error` is why a page check gave no kind. */
  | { type: "model"; step: number; text?: string; toolCalls: ToolCall[]; model?: string; durationMs: number; usage?: Usage; role?: "judge" | "checker"; error?: string }
  | { type: "tool"; step: number; call: ToolCall; result: ToolResult }
  | { type: "done"; result: AgentResult }

export interface AgentResult {
  status: "completed" | "max_steps" | "failed"
  /** Execution termination, distinct from the model's unverified assessment. */
  stopReason: "final_answer" | "step_limit" | "tool_failures" | "model_error" | "timeout" | "cancelled" | "no_progress"
  answer: string
  outcome: {
    status: "succeeded" | "partial" | "blocked" | "unknown"
    /** `judged` when the judge model checked this answer, which claimed success, against the page evidence; see `judge`. */
    verification: "unverified" | "judged"
    unfinished: string[]
    /** The judge's verdict: the judge model's adapter name, its probability that the evidence supports the answer, and why. */
    judge?: { model: string; supported: number; reason?: string }
  }
  /** Last 20 distinct HTTP(S) URLs actually observed; not verified citations. */
  observedUrls: string[]
  durationMs: number
  error?: string
  steps: number
  /** Summed over the run's model calls; see `sumUsage`. */
  usage: Usage & { inputTokens: number; outputTokens: number }
  /** The judge model's calls, summed the same way and kept apart because its tokens have another price; set once the judge replied. */
  judgeUsage?: Usage & { inputTokens: number; outputTokens: number }
  /** Why the last judge request gave no verdict. The answer and outcome stay as they were. */
  judgeError?: string
  /** The checker model's calls, summed like `judgeUsage`; set once the checker replied. */
  checkerUsage?: Usage & { inputTokens: number; outputTokens: number }
  /** Why the last page check gave no page kind. The tool result it checked stayed as it was. */
  checkerError?: string
}

export interface AgentOptions {
  task: string
  model: ModelAdapter
  browser: BrowserSession
  tools?: BrowserTool[]
  maxSteps?: number
  /** Stop after this many steps in a row where every tool call failed. */
  maxConsecutiveFailures?: number
  /** Total task deadline, including model requests (default five minutes). */
  timeoutMs?: number
  /** Stop after identical action/state steps; waits and scrolls are exempt (default three). */
  maxRepeatedSteps?: number
  /** Clock used for the run's date (default current time). */
  now?: Date
  /** Time zone used for the run's date (default process time zone). */
  timeZone?: string
  systemPrompt?: string
  /**
   * Checks a final answer whose outcome is succeeded against the page content still in context, in one tool-less request.
   * When the judge is sure the answer is unsupported, the agent continues once with its finding, or marks the outcome
   * partial when no step is left. A failed judge request changes nothing; the result's `judgeError` says why it failed.
   */
  judgeModel?: ModelAdapter
  /**
   * Asks which kind of page a tool result opened, in one tool-less request of at most five seconds (see `pageChecker`).
   * When the checker is sure of a block, a rate limit, a missing page, a sign-in wall or a covering dialog, the result
   * gets one fixed sentence saying so; on an empty results page the browser waits 2 s and takes a new snapshot. A failed
   * check changes nothing; the result's `checkerError` says why it failed.
   */
  checkerModel?: ModelAdapter
  signal?: AbortSignal
  onEvent?: (event: AgentEvent) => void
}

type Entry = Message
  | { role: "user"; task: string; dateLine: string; snapshot: string }
  | { role: "tool"; toolCallId: string; name: string; result: ToolResult }

export async function runAgent(options: AgentOptions): Promise<AgentResult> {
  const timeoutMs = options.timeoutMs ?? 300_000
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) throw new Error("timeoutMs must be a positive integer up to 2147483647")
  const dateLine = todayLine(options.now ?? new Date(), options.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone)
  const deadline = new AbortController()
  const timer = setTimeout(() => deadline.abort(new Error("Task deadline exceeded")), timeoutMs)
  const signal = options.signal ? AbortSignal.any([options.signal, deadline.signal]) : deadline.signal
  const startedAt = performance.now()
  const observedUrls = new Set<string>()
  const observe = () => {
    const url = options.browser.currentUrl
    if (url && /^https?:\/\//.test(url)) {
      observedUrls.delete(url)
      observedUrls.add(url)
      if (observedUrls.size > 20) observedUrls.delete(observedUrls.values().next().value!)
    }
  }
  observe()
  const tools = options.tools ?? selectTools()
  const specs = tools.map(toolSpec)
  const maxSteps = options.maxSteps ?? 30
  const maxFailures = options.maxConsecutiveFailures ?? 3
  const system = options.systemPrompt ?? SYSTEM_PROMPT
  const callUsage: Array<Usage | undefined> = []
  const judgeUsage: Array<Usage | undefined> = []
  const checkerUsage: Array<Usage | undefined> = []
  const emit = options.onEvent ?? (() => {})

  const entries: Entry[] = []
  let failures = 0
  let step = 0
  let previousState = ""
  let repeatedSteps = 0
  let partialAnswer = ""
  let sentBack = false
  let judgeError: string | undefined
  let checkerError: string | undefined
  const revisit = revisits()
  const checkPage = options.checkerModel && pageChecker(options.checkerModel, options.browser, signal)

  const finish = (status: AgentResult["status"], stopReason: AgentResult["stopReason"], text: string, error?: string, outcome?: AgentResult["outcome"]): AgentResult => {
    const final = parseFinalAnswer(text)
    if (outcome) final.outcome = outcome
    const result: AgentResult = {
      status, stopReason, ...final, observedUrls: [...observedUrls], durationMs: Math.round(performance.now() - startedAt), steps: step, usage: sumUsage(callUsage),
      ...(judgeUsage.length ? { judgeUsage: sumUsage(judgeUsage) } : {}), ...(judgeError ? { judgeError } : {}),
      ...(checkerUsage.length ? { checkerUsage: sumUsage(checkerUsage) } : {}), ...(checkerError ? { checkerError } : {}), ...(error ? { error } : {}),
    }
    emit({ type: "done", result })
    return result
  }
  const ask = async (withTools: boolean, outcomeOnly = false) => {
    const requestedAt = performance.now()
    const response = await interruptible(() => options.model.complete({
      system,
      messages: render(entries, options.task),
      tools: withTools ? specs : [],
      signal,
    }), signal)
    const durationMs = Math.round(performance.now() - requestedAt)
    callUsage.push(response.usage)
    emit({ type: "model", step, text: response.text, toolCalls: response.toolCalls, model: response.model, durationMs, usage: response.usage })
    if (!outcomeOnly && response.toolCalls.length === 0 && !parseFinalAnswer(response.text ?? "").answer.trim()) {
      throw new Error(`Model returned no answer or tool calls${response.finishReason ? ` (finish reason: ${response.finishReason})` : ""}`)
    }
    if (!outcomeOnly && response.text?.trim()) partialAnswer = response.text
    entries.push({ role: "assistant", text: response.text, toolCalls: response.toolCalls })
    return response
  }
  /** Before stopping without a final answer, ask once without tools for the best answer so far; keep `fallback` if that fails or is empty. */
  const bestEffortAnswer = async (notice: string, fallback: string) => {
    entries.push({
      role: "user",
      content: [{ type: "text", text: `${notice} Reply now with your best final answer from what you have seen, then the final outcome line {"outcome":"succeeded|partial|blocked","unfinished":["any remaining work"]}.` }],
    })
    try {
      const last = await ask(false)
      if (last.toolCalls.length === 0) return last.text?.trim() ?? ""
    } catch { /* Keep the earlier answer if the best-effort request fails or returns no answer. */ }
    return fallback
  }
  /** Ask the judge whether the page content in context supports the answer; undefined, with `judgeError` set, when the request fails or holds no verdict. */
  const judge = async (judgeModel: ModelAdapter, answer: string) => {
    const requestedAt = performance.now()
    try {
      const response = await interruptible(() => judgeModel.complete({ ...judgeRequest(options.task, answer, latestPages(entries), dateLine), signal }), signal)
      judgeUsage.push(response.usage)
      emit({ type: "model", role: "judge", step, text: response.text, toolCalls: response.toolCalls, model: response.model, durationMs: Math.round(performance.now() - requestedAt), usage: response.usage })
      const verdict = parseVerdict(response.text)
      if (!verdict) throw new Error(`${judgeModel.name} replied without a verdict`)
      return { model: judgeModel.name, ...verdict }
    } catch (error) {
      judgeError = error instanceof Error ? error.message : String(error)
      return undefined
    }
  }
  /** Trace a page check after the result it checked, with its usage once the checker replied and why it gave no kind. */
  const recordCheck = ({ response, error, durationMs }: PageCheckCall) => {
    if (response) checkerUsage.push(response.usage)
    if (error) checkerError = error
    emit({ type: "model", role: "checker", step, text: response?.text, toolCalls: response?.toolCalls ?? [], model: response?.model, durationMs, usage: response?.usage, ...(error ? { error } : {}) })
  }

  try {
    signal.throwIfAborted()
    const initial = await interruptible(() => taskMessage(options, dateLine), signal, pending => options.browser.cancelPending(pending))
    entries.push(initial)
    if ("snapshot" in initial) revisit("", { text: "", snapshot: initial.snapshot })
    while (step < maxSteps) {
      signal.throwIfAborted()
      step += 1
      emit({ type: "step", step })

      const response = await ask(true)
      if (response.toolCalls.length === 0) {
        const answer = response.text?.trim() ?? ""
        const final = parseFinalAnswer(answer)
        let { outcome } = final
        signal.throwIfAborted()
        if (outcome.status === "unknown") {
          entries.push({
            role: "user",
            content: [{ type: "text", text: 'For your previous answer, reply only with the final outcome line: {"outcome":"succeeded|partial|blocked","unfinished":["any remaining work"]}.' }],
          })
          try {
            const followUp = await ask(false, true)
            if (followUp.toolCalls.length === 0) outcome = parseFinalAnswer(`${answer}\n${followUp.text ?? ""}`).outcome
          } catch { /* Keep the original answer if the optional outcome request fails. */ }
        }
        // Only an answer that claims success is judged. A failed judge request leaves the answer and outcome as they were.
        const verdict = outcome.status === "succeeded" && options.judgeModel ? await judge(options.judgeModel, final.answer) : undefined
        if (verdict) {
          outcome = { ...outcome, verification: "judged", judge: verdict }
          if (verdict.supported <= UNSUPPORTED_AT) {
            const finding = `A check against the page evidence found the answer unsupported.${verdict.reason ? ` Reason: ${verdict.reason}` : ""}`
            outcome = { ...outcome, status: "partial", unfinished: [...outcome.unfinished, finding] }
            // With a step left, send the answer back once. The corrected answer is judged again but not sent back.
            if (step < maxSteps && !sentBack) {
              sentBack = true
              // A run that ends before the corrected answer reports this one as partial, not as succeeded.
              partialAnswer = `${final.answer}\n${JSON.stringify({ outcome: "partial", unfinished: outcome.unfinished })}`
              entries.push({ role: "user", content: [{ type: "text", text: `${finding}\nVerify the facts in the browser, then reply with your corrected final answer and the outcome line.` }] })
              continue
            }
          }
        }
        return finish("completed", "final_answer", answer, undefined, outcome)
      }

      let failed = 0
      let revisited = ""
      const state = createHash("sha256")
      let canCompare = true
      for (const call of response.toolCalls) {
        signal.throwIfAborted()
        const result = await interruptible(() => callTool(tools, options.browser, call.name, call.arguments), signal, pending => options.browser.cancelPending(pending))
        observe()
        if (result.isError) failed += 1
        if (result.isError || ["browser_wait_for", "browser_scroll"].includes(call.name) || (!result.snapshot && !result.pageText)) canCompare = false
        state.update(JSON.stringify([call.name, call.arguments, result.snapshot, result.pageText ? result.text : undefined]))
        revisited = revisit(call.name, result) ?? revisited
        // A sure page check adds a fixed sentence, or a newer snapshot, before the result enters the transcript.
        const checked = checkPage ? await checkPage(call.name, result) : { result, call: undefined }
        emit({ type: "tool", step, call, result: checked.result })
        if (checked.call) recordCheck(checked.call)
        entries.push({ role: "tool", toolCallId: call.id, name: call.name, result: checked.result })
      }

      const fingerprint = canCompare ? state.digest("hex") : ""
      repeatedSteps = fingerprint && fingerprint === previousState ? repeatedSteps + 1 : 1
      previousState = fingerprint
      const stalled = fingerprint && repeatedSteps >= (options.maxRepeatedSteps ?? 3) ? "Stopped after repeated identical actions and page state" : revisited
      if (stalled) {
        return finish("failed", "no_progress", await bestEffortAnswer("Stopping because the last steps made no progress.", partialAnswer), stalled)
      }
      failures = failed === response.toolCalls.length ? failures + 1 : 0
      if (failures >= maxFailures) {
        return finish("failed", "tool_failures", await bestEffortAnswer(`Stopping because every browser action failed in the last ${failures} steps.`, `Stopped after ${failures} consecutive steps where every browser action failed.`))
      }
    }

    // Out of steps: one last tool-less call so the caller still gets the best available answer.
    return finish("max_steps", "step_limit", await bestEffortAnswer("Step limit reached.", partialAnswer))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (signal.aborted) return finish("failed", signal.reason === deadline.signal.reason ? "timeout" : "cancelled", partialAnswer, message)
    return finish("failed", "model_error", partialAnswer, message)
  } finally {
    clearTimeout(timer)
  }
}

function parseFinalAnswer(text: string): Pick<AgentResult, "answer" | "outcome"> {
  // OpenAI models can emit citations as private-use markers: U+E200 "cite" U+E202 ref U+E201.
  const cleanAnswer = (answer: string) => answer.replace(/\ue200[\s\S]*?\ue201|[\ue200-\ue202]/g, "").trimEnd()
  const fenced = /```json\s*(\{[\s\S]*\})\s*```\s*$/.exec(text)
  const body = fenced ? fenced[1]! : text.trimEnd()
  const prefix = fenced ? text.slice(0, fenced.index).trim() : ""
  // Try only objects ending at the end of the reply, never JSON followed by prose.
  for (let start = 0; start >= 0 && start < body.length; start = body.indexOf("{", start + 1)) {
    try {
      const parsed = JSON.parse(body.slice(start))
      const prose = fenced ? prefix : body.slice(0, start).trim()
      const answer = parsed?.answer === undefined && prose ? prose : parsed?.answer
      if (parsed && typeof answer === "string" && ["succeeded", "partial", "blocked"].includes(parsed.outcome)
        && Array.isArray(parsed.unfinished) && parsed.unfinished.every((item: unknown) => typeof item === "string")) {
        return { answer: cleanAnswer(answer), outcome: { status: parsed.outcome, verification: "unverified", unfinished: parsed.unfinished } }
      }
      break
    } catch { /* Legacy/plain-text models still work; do not infer success from prose. */ }
    if (fenced) break
  }
  return { answer: cleanAnswer(text), outcome: { status: "unknown", verification: "unverified", unfinished: [] } }
}

/** A finished model response is not proof that the task succeeded. */
export function taskIncomplete(result: AgentResult): boolean {
  return result.status !== "completed" || result.outcome.status === "blocked" || result.outcome.status === "partial"
}

/**
 * Sum per-call usage. Input and output tokens count a missing value as zero; cache counts add up the calls
 * that reported them. Cost appears only when every call reported one, since a partial sum would understate it.
 */
export function sumUsage(calls: Array<Usage | undefined>): AgentResult["usage"] {
  const total: AgentResult["usage"] = { inputTokens: 0, outputTokens: 0 }
  for (const call of calls) {
    for (const key of ["inputTokens", "outputTokens", "cachedInputTokens", "cacheWriteTokens", "cost"] as const) {
      const value = call?.[key]
      if (value !== undefined) total[key] = (total[key] ?? 0) + value
    }
  }
  if (calls.some((call) => call?.cost === undefined)) delete total.cost
  return total
}

function todayLine(now: Date, timeZone: string): string {
  let formatter: Intl.DateTimeFormat
  try {
    formatter = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "long", year: "numeric", month: "2-digit", day: "2-digit" })
  } catch {
    throw new Error(`Invalid timeZone: ${timeZone}`)
  }
  const parts = formatter.formatToParts(now)
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)!.value
  return `Today is ${part("weekday")}, ${part("year")}-${part("month")}-${part("day")} (${timeZone}).`
}

async function taskMessage(options: AgentOptions, dateLine: string): Promise<Entry> {
  if (!options.browser.started) return { role: "user", content: [{ type: "text", text: `${dateLine}\n\nTask: ${options.task}\n\nThe browser has not opened any page yet.` }] }
  return { role: "user", task: options.task, dateLine, snapshot: await options.browser.snapshot() }
}

/** Tools that only look at the current page: on the same URL, what they see neither counts as a return nor resets the counts. */
const OBSERVING = ["browser_snapshot", "browser_wait_for", "browser_scroll", "browser_get_text"]
/** A first visit with this many new lines is new content even when a large shared template keeps them under a third of the page. */
const NEW_CONTENT_LINES = 10

/**
 * Count returns with nothing new seen since, and return why to stop at the fourth repeat of any of them:
 * - opening a page again (its URL without fragment plus its title) by navigating, or with any tool that reaches another URL
 * - coming back through an action, such as a click, key press, typing or selecting, to a state of the current page seen
 *   before: its URL, title and snapshot without refs, which pages renumber when they render an element again
 * - reading the same text of a page again
 * New content resets every count, so a list revisited between new detail pages never adds up: a snapshot of a page
 * opened or of an action that is more than a third new lines (ads, clocks and live numbers change fewer), or a first
 * visit to a page or state with at least NEW_CONTENT_LINES new lines. Another guessed URL that shows the same not-found
 * page brings neither. Text reads are formatted unlike snapshots, so new text resets only the counts of text reads.
 * Coming straight back to the state or text just seen is left to the check for identical consecutive steps.
 */
function revisits() {
  // Per page, state and text: how often it was reached, and its repeats since the last new content.
  const counts = new Map<string, { visits: number; repeats: number }>()
  const states = new Set<string>()
  const snapshotLines = new Set<string>()
  const textLines = new Set<string>()
  let url = ""
  let state = ""
  let read = ""
  const hash = (text: string) => createHash("sha256").update(text).digest("hex")
  /** Remember the lines; true when they are new content. */
  const learn = (seen: Set<string>, lines: string[], first: boolean) => {
    const unique = new Set(lines)
    let fresh = 0
    for (const line of unique) if (!seen.has(line)) { seen.add(line); fresh++ }
    return fresh * 3 > unique.size || (first && fresh >= NEW_CONTENT_LINES)
  }
  const reset = (kind: string) => { for (const [key, entry] of counts) if (key.startsWith(kind)) entry.repeats = 0 }
  /** Count reaching `key`, as a repeat when `again`; its visits once it has four repeats since the last reset. */
  const reach = (key: string, again: boolean) => {
    const entry = counts.get(key) ?? { visits: 0, repeats: 0 }
    counts.set(key, entry)
    entry.visits++
    if (again) entry.repeats++
    return entry.repeats > 3 ? entry.visits : 0
  }
  return (tool: string, result: ToolResult): string | undefined => {
    if (result.isError) return undefined
    let stop: string | undefined
    const [address = "", title, , , ...body] = result.snapshot?.split("\n") ?? []
    if (address.startsWith("Page URL: ")) {
      const next = address.slice("Page URL: ".length).replace(/#.*/, "")
      const lines = body.map((line) => line.replace(/\[ref=\w+\]/g, ""))
      const page = `page\n${next}\n${title}`
      const reached = `state\n${hash(`${next}\n${title}\n${lines.join("\n")}`)}`
      // Navigating opens a page even at the current URL; other tools must reach another URL to open one.
      const opened = tool === "browser_navigate" || next !== url
      const news = learn(snapshotLines, lines, opened ? !counts.has(page) : !states.has(reached))
      const returned = states.has(reached) && reached !== state
      url = next
      state = reached
      states.add(reached)
      if (opened) {
        if (news) reset("")
        const visits = reach(page, !news && counts.has(page))
        if (visits) stop = `Stopped after opening ${url} ${visits} times without finding anything new`
      } else if (!OBSERVING.includes(tool)) {
        if (news) reset("")
        const visits = returned && !news ? reach(reached, true) : 0
        if (visits) stop = `Stopped after returning to the same state of ${url} ${visits} times without finding anything new`
      }
    }
    if (result.pageText) {
      // A truncation notice names the element's ref, which can change between reads of the same text.
      const text = result.text.replace(/\bref=\w+/g, "")
      const key = `text\n${hash(`${url}\n${text}`)}`
      const news = learn(textLines, text.split("\n"), !counts.has(key))
      if (news) reset("text\n")
      const visits = reach(key, !news && counts.has(key) && key !== read)
      read = key
      if (visits) stop = `Stopped after reading the same text of ${url} ${visits} times without finding anything new`
    }
    return stop
  }
}

/** The newest page text and snapshot: the page content that `render` still keeps in context. */
function latestPages(entries: Entry[]): { text?: string; snapshot?: string } {
  const pages: { text?: string; snapshot?: string } = {}
  for (const entry of entries.toReversed()) {
    if ("snapshot" in entry) pages.snapshot ??= entry.snapshot
    else if ("result" in entry) {
      if (entry.result.pageText) pages.text ??= entry.result.text
      if (entry.result.snapshot !== undefined) pages.snapshot ??= entry.result.snapshot
    }
  }
  return pages
}

const OMITTED_SNAPSHOT = "[older snapshot omitted: superseded by a newer one]"
/** Superseded pages that keep a digest; page state older than theirs becomes a placeholder. */
const DIGEST_PAGES = 4
/** Characters in one digest, its label included. */
const DIGEST_CHARS = 1_500
/** The header that `BrowserSession.snapshot` puts before the tree. */
const SNAPSHOT_HEADER = /^Page URL: ([^\n]*)\nPage title: ([\s\S]*?)\nPage tab: [^\n]*\nSnapshot:\n/

/**
 * Keep the newest snapshot, page text and image whole. Superseded snapshots and page texts of the last few pages keep a
 * digest of their task-relevant lines (see `pageDigests`); older page state becomes a placeholder.
 */
export function render(entries: Entry[], task: string): Message[] {
  const lastSnapshot = entries.findLastIndex((entry) => snapshotOf(entry) !== undefined)
  const lastPageText = entries.findLastIndex((entry) => textOf(entry) !== undefined)
  const lastImage = entries.findLastIndex((entry) => "result" in entry && entry.result.image !== undefined)
  const digests = pageDigests(entries, task)

  return entries.map((entry, index): Message => {
    if ("snapshot" in entry) {
      const snapshot = index === lastSnapshot ? entry.snapshot : digests.get(`snapshot ${index}`) ?? OMITTED_SNAPSHOT
      return { role: "user", content: [{ type: "text", text: `${entry.dateLine}\n\nTask: ${entry.task}\n\nCurrent page:\n${snapshot}` }] }
    }
    if (!("result" in entry)) return entry
    const result: ToolResult = { ...entry.result }
    if (result.pageText && index !== lastPageText) result.text = digests.get(`text ${index}`) ?? "[older page text omitted: superseded by a newer read]"
    if (result.snapshot !== undefined && index !== lastSnapshot) {
      result.snapshot = digests.get(`snapshot ${index}`) ?? OMITTED_SNAPSHOT
    }
    if (result.image !== undefined && index !== lastImage) {
      result.image = undefined
      result.text += " [older screenshot omitted]"
    }
    return {
      role: "tool",
      toolCallId: entry.toolCallId,
      name: entry.name,
      content: resultContent(result),
      isError: result.isError,
    }
  })
}

function snapshotOf(entry: Entry): string | undefined {
  return "snapshot" in entry ? entry.snapshot : "result" in entry ? entry.result.snapshot : undefined
}

function textOf(entry: Entry): string | undefined {
  return "result" in entry && entry.result.pageText ? entry.result.text : undefined
}

/**
 * Digests of the newest DIGEST_PAGES superseded pages, keyed by kind and entry index. A snapshot belongs to the page at
 * its URL, and a text read or a snapshot without a URL to its text. Going back from the newest entry, the newest snapshot
 * and text read are shown whole, and every other page counts once, at its newest entry; a page shown whole gets no
 * digest. This depends only on the task and the entries from each one on, so an entry only moves from whole to digest to
 * placeholder, and messages before the first one that moves stay byte-identical for prompt caching.
 */
function pageDigests(entries: Entry[], task: string): Map<string, string> {
  // A URL in the task, such as where to start, is not a fact to find; its pieces would match every link on the site.
  const query = task.replace(/https?:\/\/\S+/g, " ")
  const digests = new Map<string, string>()
  const seen = new Set<string>()
  const shownWhole = new Set<string>()
  let pages = 0
  for (let index = entries.length - 1; index >= 0 && pages < DIGEST_PAGES; index--) {
    const entry = entries[index]!
    for (const [kind, content] of [["text", textOf(entry)], ["snapshot", snapshotOf(entry)]] as const) {
      if (content === undefined) continue
      const page = kind === "text" ? `text ${content}` : `snapshot ${SNAPSHOT_HEADER.exec(content)?.[1] ?? content}`
      const covered = seen.has(page)
      seen.add(page)
      if (!shownWhole.has(kind)) shownWhole.add(kind)
      else if (!covered && pages < DIGEST_PAGES) {
        pages += 1
        const digest = digestOf(kind, content, query)
        if (digest !== undefined) digests.set(`${kind} ${index}`, digest)
      }
    }
  }
  return digests
}

/**
 * A superseded page cut to DIGEST_CHARS: a label, a snapshot's URL and title, and the lines that match `query`.
 * Undefined for a long page without a matching line, since its start is usually navigation, and for a snapshot
 * without the page header, which marks unavailable page state.
 */
function digestOf(kind: "text" | "snapshot", content: string, query: string): string | undefined {
  let label = "[older page text, reduced to task-relevant lines]"
  let body = content
  if (kind === "snapshot") {
    const header = SNAPSHOT_HEADER.exec(content)
    if (!header) return undefined
    label = `[older snapshot, reduced to task-relevant lines; refs removed and not usable]\nPage URL: ${compactLine(header[1]!, 160)}\nPage title: ${compactLine(header[2]!, 120)}`
    // Like refs, link targets serve acting; their slugs repeat the link text and would crowd out the page's facts.
    body = withoutRefs(content.slice(header[0].length)).replace(/^ *- \/url: .*\n?/gm, "")
  }
  const lines = matchingLines(body, query, DIGEST_CHARS - label.length - 1)
  return lines?.trim() ? `${label}\n${lines}` : undefined
}

import { createHash } from "node:crypto"
import { interruptible } from "./cancel"
import type { BrowserSession } from "./browser"
import { judgeRequest, parseVerdict, UNSUPPORTED_AT } from "./judge"
import type { Message, ModelAdapter, ToolCall, Usage } from "./model/types"
import { type BrowserTool, callTool, resultContent, selectTools, type ToolResult, toolSpec } from "./tools"

export const SYSTEM_PROMPT = `You are a web agent that completes the user's task by operating a real browser through tools.

- Page state arrives as accessibility snapshots. Act on elements with their [ref=…] values from the most recent snapshot only; refs from older snapshots may be stale.
- Actions return a fresh snapshot, so you rarely need browser_snapshot right after acting.
- Prefer navigating directly to a URL when you know it. If a URL you guessed returns HTTP 404, stop guessing URLs on that site and use its links or search instead. Use browser_get_text to read long content.
- Older snapshots are omitted. Before leaving a page whose facts you still need, read the relevant content with browser_get_text so it survives a tab switch. Before another text read, preserve earlier needed facts in a brief assistant note; only the newest text read is retained.
- If an action fails, look at the new snapshot and try a different approach instead of repeating the same call.
- If a page's content, landing URL, or title indicates a bot check, CAPTCHA, or access denial (e.g. google.com/sorry or "Just a moment..."), or the server responds with HTTP 401, 402, 403, or 429, do not retry that site for the rest of this task, even with a different URL or query; use another site or search engine.
- After a site is blocked, do not keep rewriting search queries whose results point back to it: after three searches without opening a result, answer from what you have seen, with outcome blocked or partial.
- For lowest/highest/newest questions, use the site's sort or filter when available, otherwise compare every candidate you saw before answering.
- Never invent facts: base the answer on what you saw in the browser.
- When finished, reply without tool calls: write your user-facing answer first, then a final line containing only {"outcome":"succeeded|partial|blocked","unfinished":["any remaining work"]}. This is your own assessment, not independent verification. If you cannot complete the task, explain why in the answer and list the remaining work. That ends the run.`

export type AgentEvent =
  | { type: "step"; step: number }
  /** `role` is set on the judge model's calls; agent model calls leave it out. */
  | { type: "model"; step: number; text?: string; toolCalls: ToolCall[]; model?: string; durationMs: number; usage?: Usage; role?: "judge" }
  | { type: "tool"; step: number; call: ToolCall; result: ToolResult }
  | { type: "done"; result: AgentResult }

export interface AgentResult {
  status: "completed" | "max_steps" | "failed"
  /** Execution termination, distinct from the model's unverified assessment. */
  stopReason: "final_answer" | "step_limit" | "tool_failures" | "model_error" | "timeout" | "cancelled" | "no_progress"
  answer: string
  outcome: {
    status: "succeeded" | "partial" | "blocked" | "unknown"
    /** `judged` when the judge model checked this succeeded answer against the page evidence; see `judge`. */
    verification: "unverified" | "judged"
    unfinished: string[]
    /** The judge's verdict: the model that judged, its probability that the evidence supports the answer, and why. */
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
  systemPrompt?: string
  /**
   * Checks a final answer whose outcome is succeeded against the page content still in context, in one tool-less request.
   * When the judge is sure the answer is unsupported, the agent continues once with its finding, or marks the outcome
   * partial when no step is left. A failed judge request changes nothing.
   */
  judgeModel?: ModelAdapter
  signal?: AbortSignal
  onEvent?: (event: AgentEvent) => void
}

type Entry = Message
  | { role: "user"; task: string; snapshot: string }
  | { role: "tool"; toolCallId: string; name: string; result: ToolResult }

export async function runAgent(options: AgentOptions): Promise<AgentResult> {
  const timeoutMs = options.timeoutMs ?? 300_000
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) throw new Error("timeoutMs must be a positive integer up to 2147483647")
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
  const emit = options.onEvent ?? (() => {})

  const entries: Entry[] = []
  let failures = 0
  let step = 0
  let previousState = ""
  let repeatedSteps = 0
  let partialAnswer = ""
  let sentBack = false
  const visit = pageVisits()

  const finish = (status: AgentResult["status"], stopReason: AgentResult["stopReason"], text: string, error?: string, outcome?: AgentResult["outcome"]): AgentResult => {
    const final = parseFinalAnswer(text)
    if (outcome) final.outcome = outcome
    const result: AgentResult = {
      status, stopReason, ...final, observedUrls: [...observedUrls], durationMs: Math.round(performance.now() - startedAt), steps: step, usage: sumUsage(callUsage),
      ...(judgeUsage.length ? { judgeUsage: sumUsage(judgeUsage) } : {}), ...(error ? { error } : {}),
    }
    emit({ type: "done", result })
    return result
  }
  const ask = async (withTools: boolean, outcomeOnly = false) => {
    const requestedAt = performance.now()
    const response = await interruptible(() => options.model.complete({
      system,
      messages: render(entries),
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
  /** Ask the judge whether the page content in context supports the answer; undefined when the request fails or holds no verdict. */
  const judge = async (judgeModel: ModelAdapter, answer: string) => {
    const requestedAt = performance.now()
    try {
      const response = await interruptible(() => judgeModel.complete({ ...judgeRequest(options.task, answer, latestPages(entries)), signal }), signal)
      judgeUsage.push(response.usage)
      emit({ type: "model", role: "judge", step, text: response.text, toolCalls: response.toolCalls, model: response.model, durationMs: Math.round(performance.now() - requestedAt), usage: response.usage })
      const verdict = parseVerdict(response.text)
      return verdict && { model: response.model ?? judgeModel.name, ...verdict }
    } catch {
      return undefined
    }
  }

  try {
    signal.throwIfAborted()
    const initial = await interruptible(() => taskMessage(options), signal, pending => options.browser.cancelPending(pending))
    entries.push(initial)
    if ("snapshot" in initial) visit("", initial.snapshot)
    while (step < maxSteps) {
      signal.throwIfAborted()
      step += 1
      emit({ type: "step", step })

      const response = await ask(true)
      if (response.toolCalls.length === 0) {
        const answer = response.text?.trim() ?? ""
        let { outcome } = parseFinalAnswer(answer)
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
        // A failed judge request leaves the answer and outcome as they were.
        const verdict = outcome.status === "succeeded" && options.judgeModel ? await judge(options.judgeModel, parseFinalAnswer(answer).answer) : undefined
        if (verdict) {
          outcome = { ...outcome, verification: "judged", judge: verdict }
          if (verdict.supported <= UNSUPPORTED_AT) {
            const finding = `A check against the page evidence found the answer unsupported.${verdict.reason ? ` Reason: ${verdict.reason}` : ""}`
            // Send the answer back once; a second unsupported answer, or one at the step limit, becomes partial.
            if (step < maxSteps && !sentBack) {
              sentBack = true
              entries.push({ role: "user", content: [{ type: "text", text: `${finding}\nVerify the facts in the browser, then reply with your corrected final answer and the outcome line.` }] })
              continue
            }
            outcome = { ...outcome, status: "partial", unfinished: [...outcome.unfinished, finding] }
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
        const page = result.isError ? undefined : visit(call.name, result.snapshot)
        if (page?.stop) revisited = `Stopped after opening ${page.url} ${page.visits} times without finding anything new`
        emit({ type: "tool", step, call, result })
        entries.push({ role: "tool", toolCallId: call.id, name: call.name, result })
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

async function taskMessage(options: AgentOptions): Promise<Entry> {
  if (!options.browser.started) return { role: "user", content: [{ type: "text", text: `Task: ${options.task}\n\nThe browser has not opened any page yet.` }] }
  return { role: "user", task: options.task, snapshot: await options.browser.snapshot() }
}

/**
 * Count pages re-opened with nothing new seen since. A page is its URL without fragment plus its title.
 * Opening a page for the first time, or one whose snapshot is more than a third new lines (ads, clocks and
 * live numbers change fewer), resets every count, so a list revisited between new detail pages never adds up.
 */
function pageVisits() {
  const pages = new Map<string, { visits: number; repeats: number }>()
  const seen = new Set<string>()
  let current = ""
  return (tool: string, snapshot = "") => {
    const [address = "", title, , , ...body] = snapshot.split("\n")
    if (!address.startsWith("Page URL: ")) return undefined
    const url = address.slice("Page URL: ".length).replace(/#.*/, "")
    const lines = new Set(body.map((line) => line.replace(/\[ref=\w+\]/g, "")))
    let fresh = 0
    for (const line of lines) if (!seen.has(line)) { seen.add(line); fresh++ }
    // Navigating opens a page even at the current URL; other tools (scrolls, waits, clicks in place) must reach another URL.
    if (tool !== "browser_navigate" && url === current) return undefined
    current = url
    const key = `${url}\n${title}`
    const page = pages.get(key) ?? { visits: 0, repeats: 0 }
    pages.set(key, page)
    if (++page.visits === 1 || fresh * 3 > lines.size) for (const other of pages.values()) other.repeats = 0
    else page.repeats++
    return { url, visits: page.visits, stop: page.repeats > 3 }
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

/** Keep only the newest snapshot and image in context; older ones are superseded page state. */
export function render(entries: Entry[]): Message[] {
  const lastSnapshot = entries.findLastIndex((entry) => "snapshot" in entry || ("result" in entry && entry.result.snapshot !== undefined))
  const lastPageText = entries.findLastIndex((entry) => "result" in entry && entry.result.pageText)
  const lastImage = entries.findLastIndex((entry) => "result" in entry && entry.result.image !== undefined)

  return entries.map((entry, index): Message => {
    if ("snapshot" in entry) {
      const snapshot = index === lastSnapshot ? entry.snapshot : "[older snapshot omitted: superseded by a newer one]"
      return { role: "user", content: [{ type: "text", text: `Task: ${entry.task}\n\nCurrent page:\n${snapshot}` }] }
    }
    if (!("result" in entry)) return entry
    const result: ToolResult = { ...entry.result }
    if (result.pageText && index !== lastPageText) result.text = "[older page text omitted: superseded by a newer read]"
    if (result.snapshot !== undefined && index !== lastSnapshot) {
      result.snapshot = "[older snapshot omitted: superseded by a newer one]"
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

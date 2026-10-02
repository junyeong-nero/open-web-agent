import { createHash } from "node:crypto"
import { interruptible } from "./cancel"
import type { BrowserSession } from "./browser"
import type { Message, ModelAdapter, ToolCall } from "./model/types"
import { type BrowserTool, callTool, resultContent, selectTools, type ToolResult, toolSpec } from "./tools"

export const SYSTEM_PROMPT = `You are a web agent that completes the user's task by operating a real browser through tools.

- Page state arrives as accessibility snapshots. Act on elements with their [ref=…] values from the most recent snapshot only; refs from older snapshots may be stale.
- Actions return a fresh snapshot, so you rarely need browser_snapshot right after acting.
- Prefer navigating directly to a URL when you know it. Use browser_get_text to read long content.
- Older snapshots are omitted. Before leaving a page whose facts you still need, read the relevant content with browser_get_text so it survives a tab switch. Before another text read, preserve earlier needed facts in a brief assistant note; only the newest text read is retained.
- If an action fails, look at the new snapshot and try a different approach instead of repeating the same call.
- Never invent facts: base the answer on what you saw in the browser.
- When finished, reply without tool calls using JSON: {"answer":"your answer", "outcome":"succeeded|partial|blocked", "unfinished":["any remaining work"]}. This is your own assessment, not independent verification. If you cannot complete the task, say why in answer and list the remaining work. That ends the run.`

export type AgentEvent =
  | { type: "step"; step: number }
  | { type: "model"; step: number; text?: string; toolCalls: ToolCall[]; usage?: { inputTokens?: number; outputTokens?: number } }
  | { type: "tool"; step: number; call: ToolCall; result: ToolResult }
  | { type: "done"; result: AgentResult }

export interface AgentResult {
  status: "completed" | "max_steps" | "failed"
  /** Execution termination, distinct from the model's unverified assessment. */
  stopReason: "final_answer" | "step_limit" | "tool_failures" | "model_error" | "timeout" | "cancelled" | "no_progress"
  answer: string
  outcome: { status: "succeeded" | "partial" | "blocked" | "unknown"; verification: "unverified"; unfinished: string[] }
  /** Last 20 distinct HTTP(S) URLs actually observed; not verified citations. */
  observedUrls: string[]
  durationMs: number
  error?: string
  steps: number
  usage: { inputTokens: number; outputTokens: number }
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
  const usage = { inputTokens: 0, outputTokens: 0 }
  const emit = options.onEvent ?? (() => {})

  const entries: Entry[] = []
  let failures = 0
  let step = 0
  let previousState = ""
  let repeatedSteps = 0
  let partialAnswer = ""

  const finish = (status: AgentResult["status"], stopReason: AgentResult["stopReason"], text: string, error?: string): AgentResult => {
    const final = parseFinalAnswer(text)
    const result: AgentResult = { status, stopReason, ...final, observedUrls: [...observedUrls], durationMs: Math.round(performance.now() - startedAt), steps: step, usage, ...(error ? { error } : {}) }
    emit({ type: "done", result })
    return result
  }
  const ask = async (withTools: boolean) => {
    const response = await interruptible(() => options.model.complete({
      system,
      messages: render(entries),
      tools: withTools ? specs : [],
      signal,
    }), signal)
    usage.inputTokens += response.usage?.inputTokens ?? 0
    usage.outputTokens += response.usage?.outputTokens ?? 0
    emit({ type: "model", step, text: response.text, toolCalls: response.toolCalls, usage: response.usage })
    if (response.toolCalls.length === 0 && !parseFinalAnswer(response.text ?? "").answer.trim()) {
      throw new Error(`Model returned no answer or tool calls${response.finishReason ? ` (finish reason: ${response.finishReason})` : ""}`)
    }
    if (response.text?.trim()) partialAnswer = response.text
    entries.push({ role: "assistant", text: response.text, toolCalls: response.toolCalls })
    return response
  }

  try {
    signal.throwIfAborted()
    const initial = await interruptible(() => taskMessage(options), signal, pending => options.browser.cancelPending(pending))
    entries.push(initial)
    while (step < maxSteps) {
      signal.throwIfAborted()
      step += 1
      emit({ type: "step", step })

      const response = await ask(true)
      if (response.toolCalls.length === 0) return finish("completed", "final_answer", response.text?.trim() ?? "")

      let failed = 0
      const state = createHash("sha256")
      let canCompare = true
      for (const call of response.toolCalls) {
        signal.throwIfAborted()
        const result = await interruptible(() => callTool(tools, options.browser, call.name, call.arguments), signal, pending => options.browser.cancelPending(pending))
        observe()
        if (result.isError) failed += 1
        if (result.isError || ["browser_wait_for", "browser_scroll"].includes(call.name) || (!result.snapshot && !result.pageText)) canCompare = false
        state.update(JSON.stringify([call.name, call.arguments, result.snapshot, result.pageText ? result.text : undefined]))
        emit({ type: "tool", step, call, result })
        entries.push({ role: "tool", toolCallId: call.id, name: call.name, result })
      }

      const fingerprint = canCompare ? state.digest("hex") : ""
      repeatedSteps = fingerprint && fingerprint === previousState ? repeatedSteps + 1 : 1
      previousState = fingerprint
      if (fingerprint && repeatedSteps >= (options.maxRepeatedSteps ?? 3)) {
        return finish("failed", "no_progress", partialAnswer, "Stopped after repeated identical actions and page state")
      }
      failures = failed === response.toolCalls.length ? failures + 1 : 0
      if (failures >= maxFailures) {
        return finish("failed", "tool_failures", `Stopped after ${failures} consecutive steps where every browser action failed.`)
      }
    }

    // Out of steps: one last tool-less call so the caller still gets the best available answer.
    entries.push({
      role: "user",
      content: [{ type: "text", text: "Step limit reached. Reply now with your best final answer from what you have seen." }],
    })
    const last = await ask(false)
    return finish("max_steps", "step_limit", last.text?.trim() ?? "")
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

async function taskMessage(options: AgentOptions): Promise<Entry> {
  if (!options.browser.started) return { role: "user", content: [{ type: "text", text: `Task: ${options.task}\n\nThe browser has not opened any page yet.` }] }
  return { role: "user", task: options.task, snapshot: await options.browser.snapshot() }
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

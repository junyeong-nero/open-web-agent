import type { BrowserSession } from "./browser"
import type { Message, ModelAdapter, ToolCall } from "./model/types"
import { type BrowserTool, callTool, resultContent, selectTools, type ToolResult, toolSpec } from "./tools"

export const SYSTEM_PROMPT = `You are a web agent that completes the user's task by operating a real browser through tools.

- Page state arrives as accessibility snapshots. Act on elements with their [ref=…] values from the most recent snapshot only; refs from older snapshots may be stale.
- Actions return a fresh snapshot, so you rarely need browser_snapshot right after acting.
- Prefer navigating directly to a URL when you know it. Use browser_get_text to read long content.
- If an action fails, look at the new snapshot and try a different approach instead of repeating the same call.
- Never invent facts: base the answer on what you saw in the browser.
- When the task is done (or impossible), reply with the final answer as plain text and no tool calls. That ends the run.`

export type AgentEvent =
  | { type: "step"; step: number }
  | { type: "model"; step: number; text?: string; toolCalls: ToolCall[]; usage?: { inputTokens?: number; outputTokens?: number } }
  | { type: "tool"; step: number; call: ToolCall; result: ToolResult }
  | { type: "done"; result: AgentResult }

export interface AgentResult {
  status: "completed" | "max_steps" | "failed"
  answer: string
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
  systemPrompt?: string
  signal?: AbortSignal
  onEvent?: (event: AgentEvent) => void
}

type Entry = Message | { role: "tool"; toolCallId: string; name: string; result: ToolResult }

export async function runAgent(options: AgentOptions): Promise<AgentResult> {
  const tools = options.tools ?? selectTools()
  const specs = tools.map(toolSpec)
  const maxSteps = options.maxSteps ?? 30
  const maxFailures = options.maxConsecutiveFailures ?? 3
  const system = options.systemPrompt ?? SYSTEM_PROMPT
  const usage = { inputTokens: 0, outputTokens: 0 }
  const emit = options.onEvent ?? (() => {})

  const entries: Entry[] = [{ role: "user", content: [{ type: "text", text: await taskMessage(options) }] }]
  let failures = 0
  let step = 0

  const finish = (status: AgentResult["status"], answer: string): AgentResult => {
    const result = { status, answer, steps: step, usage }
    emit({ type: "done", result })
    return result
  }
  const ask = async (withTools: boolean) => {
    const response = await options.model.complete({
      system,
      messages: render(entries),
      tools: withTools ? specs : [],
      signal: options.signal,
    })
    usage.inputTokens += response.usage?.inputTokens ?? 0
    usage.outputTokens += response.usage?.outputTokens ?? 0
    emit({ type: "model", step, text: response.text, toolCalls: response.toolCalls, usage: response.usage })
    entries.push({ role: "assistant", text: response.text, toolCalls: response.toolCalls })
    return response
  }

  while (step < maxSteps) {
    options.signal?.throwIfAborted()
    step += 1
    emit({ type: "step", step })

    const response = await ask(true)
    if (response.toolCalls.length === 0) return finish("completed", response.text?.trim() ?? "")

    let failed = 0
    for (const call of response.toolCalls) {
      options.signal?.throwIfAborted()
      const result = await callTool(tools, options.browser, call.name, call.arguments)
      if (result.isError) failed += 1
      emit({ type: "tool", step, call, result })
      entries.push({ role: "tool", toolCallId: call.id, name: call.name, result })
    }

    failures = failed === response.toolCalls.length ? failures + 1 : 0
    if (failures >= maxFailures) {
      return finish("failed", `Stopped after ${failures} consecutive steps where every browser action failed.`)
    }
  }

  // Out of steps: one last tool-less call so the caller still gets the best available answer.
  entries.push({
    role: "user",
    content: [{ type: "text", text: "Step limit reached. Reply now with your best final answer from what you have seen." }],
  })
  const last = await ask(false)
  return finish("max_steps", last.text?.trim() ?? "")
}

async function taskMessage(options: AgentOptions): Promise<string> {
  if (!options.browser.started) return `Task: ${options.task}\n\nThe browser has not opened any page yet.`
  return `Task: ${options.task}\n\nCurrent page:\n${await options.browser.snapshot()}`
}

/** Keep only the newest snapshot and image in context; older ones are superseded page state. */
export function render(entries: Entry[]): Message[] {
  const lastSnapshot = entries.findLastIndex((entry) => "result" in entry && entry.result.snapshot !== undefined)
  const lastImage = entries.findLastIndex((entry) => "result" in entry && entry.result.image !== undefined)

  return entries.map((entry, index): Message => {
    if (!("result" in entry)) return entry
    const result: ToolResult = { ...entry.result }
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

import type { RunEvent } from "@open-web-agent/core"
import type { ThemeAccent } from "../theme/themes"

export interface RunLogItem {
  id: string
  sequence: number
  kind: string
  message: string
  accent: ThemeAccent
}

export function toRunLogItem(event: RunEvent): RunLogItem | null {
  if (event.type === "run.started") {
    return item(event, "user.task", String(event.payload.prompt ?? ""), "task")
  }

  if (event.type === "agent.step.completed") {
    const decision = readRecord(event.payload.decision)
    const thought = decision && typeof decision.thought === "string" ? decision.thought : ""
    if (thought.length > 0) return item(event, "reasoning", thought, "reasoning")
    return null
  }

  if (event.type === "browser.tool.started") {
    const toolCall = readRecord(event.payload.toolCall)
    const toolType = typeof toolCall?.type === "string" ? toolCall.type : "tool"
    return item(event, "tool.call", formatToolCall(toolType, toolCall), "tool")
  }

  if (event.type === "browser.tool.completed") {
    const toolCall = readRecord(event.payload.toolCall)
    const result = readRecord(event.payload.result)
    const toolType = typeof toolCall?.type === "string" ? toolCall.type : "tool"
    const ok = result?.ok === true ? "ok" : "failed"
    const message = typeof result?.message === "string" ? ` ${result.message}` : ""
    return item(event, "tool.result", `${toolType} ${ok}${message}`, result?.ok === true ? "tool" : "danger")
  }

  if (event.type === "plan.created") return item(event, "reasoning", "Created plan", "reasoning")
  if (event.type === "plan.updated") return item(event, "reasoning", "Updated plan", "reasoning")
  if (event.type === "run.completed") return item(event, "agent.answer", String(event.payload.finalAnswer ?? ""), "answer")
  if (event.type === "run.failed") return item(event, "run.failed", String(event.payload.message ?? ""), "danger")
  if (event.type === "run.cancelled") return item(event, "run.cancelled", String(event.payload.reason ?? "Run cancelled"), "warning")

  return null
}

function item(event: RunEvent, kind: string, message: string, accent: ThemeAccent): RunLogItem {
  return { id: event.id, sequence: event.sequence, kind, message, accent }
}

function formatToolCall(toolType: string, toolCall: Record<string, unknown> | null): string {
  if (toolType === "navigate" && typeof toolCall?.url === "string") return `navigate ${toolCall.url}`
  if (toolType === "wait" && typeof toolCall?.ms === "number") return `wait ${toolCall.ms}ms`
  if (toolType === "type" && typeof toolCall?.value === "string") return `type ${toolCall.value}`
  return toolType
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null
}

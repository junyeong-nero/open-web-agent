import type { RunEvent } from "@open-web-agent/core"
import type { OpenCodeAssistantMessage, OpenCodeGlobalEvent, OpenCodeTextPart } from "./types"

export interface ProjectRunEventOptions {
  directory: string
  agentId?: string | null
  modelId?: string | null
}

export function projectRunEvent(event: RunEvent, options: ProjectRunEventOptions): OpenCodeGlobalEvent[] {
  switch (event.type) {
    case "run.started":
      return [statusEvent(event, options, "busy")]
    case "run.completed":
      return [
        messageEvent(event, options),
        partEvent(event, options, finalTextPart(event, textValue(event.payload.finalAnswer, ""))),
        statusEvent(event, options, "idle"),
      ]
    case "run.failed":
    case "run.cancelled":
      return [statusEvent(event, options, "idle")]
    case "browser.tool.completed":
      return [partEvent(event, options, syntheticTextPart(event, browserToolText(event.payload)))]
    case "browser.action.completed":
      return [partEvent(event, options, syntheticTextPart(event, "browser action completed"))]
    case "observation.captured":
      return [partEvent(event, options, syntheticTextPart(event, observationText(event.payload)))]
    case "plan.created":
    case "plan.updated":
      return [partEvent(event, options, syntheticTextPart(event, "plan updated"))]
    default:
      return []
  }
}

function statusEvent(
  event: RunEvent,
  options: ProjectRunEventOptions,
  status: "busy" | "idle",
): OpenCodeGlobalEvent {
  return {
    directory: options.directory,
    payload: {
      id: `owa_${event.id}_status`,
      type: "session.status",
      properties: {
        sessionID: event.sessionId,
        status: { type: status },
      },
    },
  }
}

function messageEvent(event: RunEvent, options: ProjectRunEventOptions): OpenCodeGlobalEvent {
  return {
    directory: options.directory,
    payload: {
      id: `owa_${event.id}_message`,
      type: "message.updated",
      properties: {
        sessionID: event.sessionId,
        info: assistantMessage(event, options),
      },
    },
  }
}

function partEvent(event: RunEvent, options: ProjectRunEventOptions, part: OpenCodeTextPart): OpenCodeGlobalEvent {
  return {
    directory: options.directory,
    payload: {
      id: `owa_${event.id}_part`,
      type: "message.part.updated",
      properties: {
        sessionID: event.sessionId,
        time: Date.parse(event.createdAt),
        part,
      },
    },
  }
}

function assistantMessage(event: RunEvent, options: ProjectRunEventOptions): OpenCodeAssistantMessage {
  const modelID = options.modelId ?? "no-model"
  return {
    id: assistantMessageId(event),
    sessionID: event.sessionId,
    role: "assistant",
    parentID: "",
    time: {
      created: Date.parse(event.createdAt),
      completed: Date.parse(event.createdAt),
    },
    modelID,
    providerID: modelID === "no-model" ? "runtime" : modelID.split(":")[0],
    mode: "build",
    agent: options.agentId ?? "owa",
    path: { cwd: options.directory, root: options.directory },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  }
}

function finalTextPart(event: RunEvent, text: string): OpenCodeTextPart {
  return textPart(event, `part_${event.runId}_final`, text, false)
}

function syntheticTextPart(event: RunEvent, text: string): OpenCodeTextPart {
  return textPart(event, `part_${event.runId}_${event.sequence}`, text, true)
}

function textPart(event: RunEvent, id: string, text: string, synthetic: boolean): OpenCodeTextPart {
  const time = Date.parse(event.createdAt)
  return {
    id,
    sessionID: event.sessionId,
    messageID: assistantMessageId(event),
    type: "text",
    text,
    synthetic,
    time: { start: time, end: time },
    metadata: { owaEventType: event.type },
  }
}

function assistantMessageId(event: RunEvent): string {
  return `assistant_${event.runId}`
}

function browserToolText(payload: Record<string, unknown>): string {
  const toolCall = objectValue(payload.toolCall)
  const result = objectValue(payload.result)
  const toolType = textValue(toolCall?.type, "browser tool")
  const message = textValue(result?.message, "completed")
  return `${toolType}: ${message}`
}

function observationText(payload: Record<string, unknown>): string {
  const observation = objectValue(payload.observation)
  const title = textValue(observation?.title)
  const url = textValue(observation?.url)
  return [title, url].filter(Boolean).join(" ") || "observation captured"
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

function textValue(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback
}

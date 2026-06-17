import { ObservationSchema, type Observation, type RunEvent } from "@open-web-agent/core"
import { EMPTY_OBSERVATION, type ConversationMessage, type PlanItem, type TimelineItem, type TuiState } from "./types"

export type TuiEvent =
  | { type: "session.created"; sessionId: string }
  | { type: "run.event"; event: RunEvent }
  | { type: "slash.details" }
  | { type: "conversation.append"; message: ConversationMessage }
  | { type: "state.clear" }
  | { type: "state.reset"; projectPath: string }

export function createInitialState(projectPath: string): TuiState {
  return {
    projectPath,
    activeSessionId: null,
    activeRunId: null,
    runStatus: "idle",
    inspectorVisible: true,
    selectedEvent: null,
    conversation: [],
    timeline: [],
    plan: [],
    browser: EMPTY_OBSERVATION,
  }
}

export function reduceTuiEvent(state: TuiState, event: TuiEvent): TuiState {
  if (event.type === "state.reset") return createInitialState(event.projectPath)
  if (event.type === "state.clear") {
    return {
      ...state,
      selectedEvent: null,
      conversation: [],
      timeline: [],
      plan: [],
      browser: EMPTY_OBSERVATION,
    }
  }
  if (event.type === "session.created") return { ...state, activeSessionId: event.sessionId, runStatus: "idle" }
  if (event.type === "slash.details") return { ...state, inspectorVisible: !state.inspectorVisible }
  if (event.type === "conversation.append") {
    return { ...state, conversation: [...state.conversation, event.message] }
  }

  const runEvent = event.event
  const next: TuiState = {
    ...state,
    selectedEvent: runEvent,
    timeline: [...state.timeline, toTimelineItem(runEvent)],
  }

  if (runEvent.type === "session.created") {
    return { ...next, activeSessionId: runEvent.sessionId }
  }

  if (runEvent.type === "run.started") {
    return { ...next, activeRunId: runEvent.runId, runStatus: "running" }
  }

  if (runEvent.type === "observation.captured") {
    return { ...next, browser: readObservation(runEvent.payload.observation, state.browser) }
  }

  if (runEvent.type === "plan.created" || runEvent.type === "plan.updated") {
    return { ...next, plan: readPlanItems(runEvent.payload.items, state.plan) }
  }

  if (runEvent.type === "run.completed") {
    const finalAnswer = String(runEvent.payload.finalAnswer ?? "")
    return {
      ...next,
      runStatus: "completed",
      conversation: finalAnswer.length > 0 ? [...state.conversation, { role: "assistant", content: finalAnswer }] : state.conversation,
    }
  }

  if (runEvent.type === "run.failed") return { ...next, runStatus: "failed" }
  if (runEvent.type === "run.cancelled") return { ...next, runStatus: "cancelled" }

  return next
}

function toTimelineItem(event: RunEvent): TimelineItem {
  return {
    eventId: event.id,
    sequence: event.sequence,
    type: event.type,
    label: eventLabel(event),
  }
}

function eventLabel(event: RunEvent): string {
  if (event.type === "browser.action.started") {
    const action = event.payload.action
    if (isRecord(action) && typeof action.kind === "string") return action.kind
  }

  if (event.type === "browser.tool.completed") {
    const toolCall = event.payload.toolCall
    if (isRecord(toolCall) && typeof toolCall.type === "string") return toolCall.type
  }

  if (event.type === "run.completed") return "completed"
  if (event.type === "run.failed") return "failed"
  if (event.type === "run.cancelled") return "cancelled"

  return event.type
}

function readObservation(value: unknown, fallback: Observation): Observation {
  const parsed = ObservationSchema.safeParse(value)
  return parsed.success ? parsed.data : fallback
}

function readPlanItems(value: unknown, fallback: PlanItem[]): PlanItem[] {
  if (!Array.isArray(value)) return fallback

  const items = value.flatMap((item): PlanItem[] => {
    if (!isRecord(item)) return []
    if (typeof item.id !== "string") return []
    if (typeof item.title !== "string") return []
    if (item.status !== "pending" && item.status !== "active" && item.status !== "completed") return []
    return [{ id: item.id, title: item.title, status: item.status }]
  })

  return items.length > 0 ? items : fallback
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

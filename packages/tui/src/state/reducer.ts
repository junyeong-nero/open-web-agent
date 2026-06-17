import { ObservationSchema, type Observation, type RunEvent } from "@open-web-agent/core"
import {
  EMPTY_OBSERVATION,
  type AgentSummary,
  type ConversationMessage,
  type EnvironmentSummary,
  type ModelSummary,
  type PlanItem,
  type TimelineItem,
  type TuiState,
} from "./types"
import { toRunLogItem } from "../log/run-log"

export type TuiEvent =
  | { type: "session.created"; sessionId: string }
  | { type: "plugins.loaded"; agents: AgentSummary[]; models: ModelSummary[]; environments: EnvironmentSummary[] }
  | { type: "agent.selected"; agentId: string }
  | { type: "model.selected"; modelId: string }
  | { type: "environment.selected"; environmentId: string }
  | { type: "theme.selected"; themeId: string }
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
    selectedAgentId: "mock-agent",
    selectedModelId: null,
    selectedEnvironmentId: "mock-browser",
    selectedThemeId: "opencode",
    availableAgents: [],
    availableModels: [],
    availableEnvironments: [],
    runStatus: "idle",
    inspectorVisible: true,
    selectedEvent: null,
    conversation: [],
    timeline: [],
    runLog: [],
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
      runLog: [],
      plan: [],
      browser: EMPTY_OBSERVATION,
    }
  }
  if (event.type === "session.created") return { ...state, activeSessionId: event.sessionId, runStatus: "idle" }
  if (event.type === "plugins.loaded") {
    const selectedAgentId = event.agents.some((agent) => agent.id === state.selectedAgentId)
      ? state.selectedAgentId
      : event.agents[0]?.id ?? state.selectedAgentId
    const selectedModelId =
      state.selectedModelId && event.models.some((model) => model.id === state.selectedModelId)
        ? state.selectedModelId
        : event.models[0]?.id ?? null
    const selectedEnvironmentId = event.environments.some((environment) => environment.id === state.selectedEnvironmentId)
      ? state.selectedEnvironmentId
      : event.environments[0]?.id ?? state.selectedEnvironmentId
    return {
      ...state,
      availableAgents: event.agents,
      availableModels: event.models,
      availableEnvironments: event.environments,
      selectedAgentId,
      selectedModelId,
      selectedEnvironmentId,
    }
  }
  if (event.type === "agent.selected") return { ...state, selectedAgentId: event.agentId }
  if (event.type === "model.selected") return { ...state, selectedModelId: event.modelId }
  if (event.type === "environment.selected") return { ...state, selectedEnvironmentId: event.environmentId }
  if (event.type === "theme.selected") return { ...state, selectedThemeId: event.themeId }
  if (event.type === "slash.details") return { ...state, inspectorVisible: !state.inspectorVisible }
  if (event.type === "conversation.append") {
    const runLog =
      event.message.role === "system"
        ? [
            ...state.runLog,
            {
              id: `system-${state.runLog.length}`,
              sequence: state.runLog.length,
              kind: "system",
              message: event.message.content,
              accent: "warning" as const,
            },
          ]
        : state.runLog
    return { ...state, conversation: [...state.conversation, event.message], runLog }
  }

  const runEvent = event.event
  const next: TuiState = {
    ...state,
    selectedEvent: runEvent,
    timeline: [...state.timeline, toTimelineItem(runEvent)],
    runLog: appendRunLog(state.runLog, runEvent),
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

function appendRunLog(current: TuiState["runLog"], event: RunEvent): TuiState["runLog"] {
  const item = toRunLogItem(event)
  return item ? [...current, item] : current
}

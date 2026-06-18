import { ObservationSchema, type Observation, type RunEvent } from "@open-web-agent/core"
import {
  EMPTY_OBSERVATION,
  type AgentSummary,
  type ConversationMessage,
  type EnvironmentSummary,
  type ModelSummary,
  type PlanItem,
  type RunStatus,
  type SessionSummary,
  type SessionViewState,
  type TimelineItem,
  type TuiState,
} from "./types"
import { toRunLogItem } from "../log/run-log"

export type TuiEvent =
  | { type: "session.created"; sessionId: string; session?: SessionSummary }
  | { type: "session.selected"; sessionId: string }
  | { type: "session.updated"; session: SessionSummary }
  | { type: "session.deleted"; sessionId: string }
  | { type: "sessions.loaded"; sessions: SessionSummary[] }
  | {
      type: "plugins.loaded"
      agents: AgentSummary[]
      models: ModelSummary[]
      environments: EnvironmentSummary[]
      defaultAgentId?: string | null
      defaultModelId?: string | null
      defaultEnvironmentId?: string | null
    }
  | { type: "agent.selected"; agentId: string }
  | { type: "model.selected"; modelId: string; reasoningEffort?: string }
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
    selectedAgentId: "see-act",
    selectedModelId: null,
    selectedEnvironmentId: "playwright-browser",
    selectedThemeId: "opencode",
    runtimeSelectorKind: null,
    runtimeSelectorQuery: "",
    availableAgents: [],
    availableModels: [],
    availableEnvironments: [],
    sessions: [],
    runningSessionIds: [],
    sessionViews: {},
    ...emptySessionView(),
  }
}

export function reduceTuiEvent(state: TuiState, event: TuiEvent): TuiState {
  if (event.type === "state.reset") return createInitialState(event.projectPath)
  if (event.type === "state.clear") {
    return commitActiveView(state, {
      ...currentView(state),
      selectedEvent: null,
      conversation: [],
      timeline: [],
      runLog: [],
      plan: [],
      browser: EMPTY_OBSERVATION,
      modelActivity: idleModelActivity(),
    })
  }
  if (event.type === "sessions.loaded") {
    const sessions = sortSessions(event.sessions.map(normalizeSession))
    const sessionViews = { ...state.sessionViews }
    for (const session of sessions) sessionViews[session.id] ??= emptySessionView()
    return {
      ...state,
      sessions,
      sessionViews,
      runningSessionIds: runningSessionIds(sessions),
    }
  }
  if (event.type === "session.created") {
    const session = event.session ?? fallbackSession(event.sessionId, state.projectPath)
    const sessionView = applySessionBrowser(state.sessionViews[event.sessionId] ?? emptySessionView(), session)
    const next = {
      ...state,
      sessions: upsertSession(state.sessions, normalizeSession(session)),
      sessionViews: {
        ...state.sessionViews,
        [event.sessionId]: sessionView,
      },
    }
    return activateSession({ ...next, runningSessionIds: runningSessionIds(next.sessions) }, event.sessionId)
  }
  if (event.type === "session.selected") {
    return activateSession(
      {
        ...state,
        sessionViews: {
          ...state.sessionViews,
          [event.sessionId]: state.sessionViews[event.sessionId] ?? emptySessionView(),
        },
      },
      event.sessionId,
    )
  }
  if (event.type === "session.updated") {
    const sessions = upsertSession(state.sessions, normalizeSession(event.session))
    const view = applySessionBrowser(state.sessionViews[event.session.id] ?? emptySessionView(), event.session)
    return {
      ...state,
      sessions,
      runningSessionIds: runningSessionIds(sessions),
      sessionViews: {
        ...state.sessionViews,
        [event.session.id]: view,
      },
      ...(state.activeSessionId === event.session.id ? view : {}),
    }
  }
  if (event.type === "session.deleted") {
    const sessions = state.sessions.filter((session) => session.id !== event.sessionId)
    const { [event.sessionId]: _deleted, ...sessionViews } = state.sessionViews
    const next = { ...state, sessions, sessionViews, runningSessionIds: runningSessionIds(sessions) }
    if (state.activeSessionId !== event.sessionId) return next
    const replacement = sessions[0]?.id ?? null
    return replacement ? activateSession(next, replacement) : { ...next, activeSessionId: null, ...emptySessionView() }
  }
  if (event.type === "plugins.loaded") {
    const selectedAgentId =
      selectConfiguredId(event.defaultAgentId, event.agents) ??
      (event.agents.some((agent) => agent.id === state.selectedAgentId)
        ? state.selectedAgentId
        : event.agents[0]?.id ?? state.selectedAgentId)
    const selectedModelId =
      selectConfiguredId(event.defaultModelId, event.models) ??
      (state.selectedModelId && event.models.some((model) => model.id === state.selectedModelId)
        ? state.selectedModelId
        : event.models[0]?.id ?? null)
    const selectedEnvironmentId =
      selectConfiguredId(event.defaultEnvironmentId, event.environments) ??
      (event.environments.some((environment) => environment.id === state.selectedEnvironmentId)
        ? state.selectedEnvironmentId
        : event.environments[0]?.id ?? state.selectedEnvironmentId)
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
  if (event.type === "model.selected") {
    const availableModels =
      event.reasoningEffort === undefined
        ? state.availableModels
        : state.availableModels.map((model) =>
            model.id === event.modelId ? { ...model, reasoningEffort: event.reasoningEffort } : model,
          )
    return { ...state, selectedModelId: event.modelId, availableModels }
  }
  if (event.type === "environment.selected") return { ...state, selectedEnvironmentId: event.environmentId }
  if (event.type === "theme.selected") return { ...state, selectedThemeId: event.themeId }
  if (event.type === "slash.details") {
    return commitActiveView(state, { ...currentView(state), inspectorVisible: !state.inspectorVisible })
  }
  if (event.type === "conversation.append") {
    const view = currentView(state)
    const runLog =
      event.message.role === "system"
        ? [
            ...view.runLog,
            {
              id: `system-${view.runLog.length}`,
              sequence: view.runLog.length,
              kind: "system",
              message: event.message.content,
              accent: "warning" as const,
            },
          ]
        : view.runLog
    return commitActiveView(state, { ...view, conversation: [...view.conversation, event.message], runLog })
  }

  return reduceRunEvent(state, event.event)
}

function selectConfiguredId<T extends { id: string }>(configuredId: string | null | undefined, items: T[]): string | null {
  if (!configuredId) return null
  return items.some((item) => item.id === configuredId) ? configuredId : null
}

function reduceRunEvent(state: TuiState, runEvent: RunEvent): TuiState {
  const sessionId = runEvent.sessionId
  const view = state.sessionViews[sessionId] ?? emptySessionView()
  if (view.seenRunEventIds.includes(runEvent.id)) return state

  const nextView = reduceSessionRunEvent(view, runEvent, state)
  const sessions = upsertSessionRunStatus(ensureSession(state.sessions, sessionId, state.projectPath, runEvent), sessionId, runEvent)
  let next: TuiState = {
    ...state,
    sessions,
    runningSessionIds: runningSessionIds(sessions),
    sessionViews: {
      ...state.sessionViews,
      [sessionId]: nextView,
    },
  }

  if (!state.activeSessionId) {
    next = { ...next, activeSessionId: sessionId }
  }
  if (next.activeSessionId === sessionId) return withView(next, nextView)
  return next
}

function reduceSessionRunEvent(view: SessionViewState, runEvent: RunEvent, state: TuiState): SessionViewState {
  const next: SessionViewState = {
    ...view,
    selectedEvent: runEvent,
    seenRunEventIds: [...view.seenRunEventIds, runEvent.id],
    timeline: [...view.timeline, toTimelineItem(runEvent)],
    runLog: appendRunLog(view.runLog, runEvent),
  }

  if (runEvent.type === "run.started") {
    return { ...next, activeRunId: runEvent.runId, runStatus: "running" }
  }

  if (runEvent.type === "model.called") {
    return { ...next, modelActivity: readModelActivity(runEvent.payload, state, view, "running") }
  }

  if (runEvent.type === "model.completed") {
    return { ...next, modelActivity: readModelActivity(runEvent.payload, state, view, "idle") }
  }

  if (runEvent.type === "observation.captured") {
    return { ...next, browser: readObservation(runEvent.payload.observation, view.browser) }
  }

  if (runEvent.type === "plan.created" || runEvent.type === "plan.updated") {
    return { ...next, plan: readPlanItems(runEvent.payload.items, view.plan) }
  }

  if (runEvent.type === "run.completed") {
    const finalAnswer = String(runEvent.payload.finalAnswer ?? "")
    return {
      ...next,
      runStatus: "completed",
      modelActivity: { ...next.modelActivity, status: "idle" },
      conversation: finalAnswer.length > 0 ? [...view.conversation, { role: "assistant", content: finalAnswer }] : view.conversation,
    }
  }

  if (runEvent.type === "run.failed") return { ...next, runStatus: "failed", modelActivity: { ...next.modelActivity, status: "idle" } }
  if (runEvent.type === "run.cancelled") return { ...next, runStatus: "cancelled", modelActivity: { ...next.modelActivity, status: "idle" } }

  return next
}

function activateSession(state: TuiState, sessionId: string): TuiState {
  return withView({ ...state, activeSessionId: sessionId }, state.sessionViews[sessionId] ?? emptySessionView())
}

function commitActiveView(state: TuiState, view: SessionViewState): TuiState {
  if (!state.activeSessionId) return withView(state, view)
  return withView(
    {
      ...state,
      sessionViews: {
        ...state.sessionViews,
        [state.activeSessionId]: view,
      },
    },
    view,
  )
}

function currentView(state: TuiState): SessionViewState {
  return {
    activeRunId: state.activeRunId,
    runStatus: state.runStatus,
    modelActivity: state.modelActivity,
    inspectorVisible: state.inspectorVisible,
    selectedEvent: state.selectedEvent,
    seenRunEventIds: state.seenRunEventIds,
    conversation: state.conversation,
    timeline: state.timeline,
    runLog: state.runLog,
    plan: state.plan,
    browser: state.browser,
  }
}

function withView(state: TuiState, view: SessionViewState): TuiState {
  return {
    ...state,
    activeRunId: view.activeRunId,
    runStatus: view.runStatus,
    modelActivity: view.modelActivity,
    inspectorVisible: view.inspectorVisible,
    selectedEvent: view.selectedEvent,
    seenRunEventIds: view.seenRunEventIds,
    conversation: view.conversation,
    timeline: view.timeline,
    runLog: view.runLog,
    plan: view.plan,
    browser: view.browser,
  }
}

function emptySessionView(): SessionViewState {
  return {
    activeRunId: null,
    runStatus: "idle",
    modelActivity: idleModelActivity(),
    inspectorVisible: true,
    selectedEvent: null,
    seenRunEventIds: [],
    conversation: [],
    timeline: [],
    runLog: [],
    plan: [],
    browser: EMPTY_OBSERVATION,
  }
}

function normalizeSession(session: SessionSummary): SessionSummary {
  return {
    ...session,
    environmentId: session.environmentId ?? null,
    browser: session.browser ?? null,
    title: session.title ?? null,
    pinned: session.pinned ?? false,
    deletedAt: session.deletedAt ?? null,
    runStatus: session.runStatus ?? "idle",
  }
}

function fallbackSession(sessionId: string, projectPath: string): SessionSummary {
  return {
    id: sessionId,
    projectPath,
    projectHash: "",
    title: null,
    pinned: false,
    deletedAt: null,
    createdAt: new Date(0).toISOString(),
    runStatus: "idle",
    environmentId: null,
    browser: null,
  }
}

function ensureSession(sessions: SessionSummary[], sessionId: string, projectPath: string, event: RunEvent): SessionSummary[] {
  const payloadSession = isRecord(event.payload.session) ? event.payload.session : null
  const session =
    payloadSession && typeof payloadSession.id === "string"
      ? normalizeSession({
          id: payloadSession.id,
          projectPath: readString(payloadSession.projectPath) ?? projectPath,
          projectHash: readString(payloadSession.projectHash) ?? "",
          title: readNullableString(payloadSession.title),
          pinned: payloadSession.pinned === true,
          deletedAt: readNullableString(payloadSession.deletedAt),
          createdAt: readString(payloadSession.createdAt) ?? new Date(0).toISOString(),
          runStatus: "idle",
          environmentId: readNullableString(payloadSession.environmentId),
          browser: readObservation(payloadSession.browser, EMPTY_OBSERVATION),
        })
      : fallbackSession(sessionId, projectPath)

  return sessions.some((current) => current.id === sessionId) ? sessions : upsertSession(sessions, session)
}

function upsertSession(sessions: SessionSummary[], session: SessionSummary): SessionSummary[] {
  const next = sessions.filter((current) => current.id !== session.id)
  if (!session.deletedAt) next.push(session)
  return sortSessions(next)
}

function applySessionBrowser(view: SessionViewState, session: SessionSummary): SessionViewState {
  return session.browser ? { ...view, browser: session.browser } : view
}

function upsertSessionRunStatus(sessions: SessionSummary[], sessionId: string, event: RunEvent): SessionSummary[] {
  const runStatus = runStatusFromEvent(event)
  if (!runStatus) return sessions
  return sortSessions(sessions.map((session) => (session.id === sessionId ? { ...session, runStatus } : session)))
}

function runStatusFromEvent(event: RunEvent): RunStatus | null {
  if (event.type === "run.started") return "running"
  if (event.type === "run.completed") return "completed"
  if (event.type === "run.failed") return "failed"
  if (event.type === "run.cancelled") return "cancelled"
  return null
}

function sortSessions(sessions: SessionSummary[]): SessionSummary[] {
  return [...sessions].sort((left, right) => {
    if (left.pinned !== right.pinned) return left.pinned ? -1 : 1
    return right.createdAt.localeCompare(left.createdAt)
  })
}

function runningSessionIds(sessions: SessionSummary[]): string[] {
  return sessions.filter((session) => session.runStatus === "running").map((session) => session.id)
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

function idleModelActivity() {
  return {
    status: "idle" as const,
    modelId: null,
    modelName: null,
    provider: null,
    reasoningEffort: null,
    contextWindowTokens: null,
    usage: null,
  }
}

function readModelActivity(
  payload: Record<string, unknown>,
  state: TuiState,
  view: SessionViewState,
  status: TuiState["modelActivity"]["status"],
) {
  const response = isRecord(payload.response) ? payload.response : null
  const usage = response ? readModelUsage(response.usage) : view.modelActivity.usage
  const modelId = readString(payload.modelId) ?? state.selectedModelId
  const summary = modelId ? state.availableModels.find((model) => model.id === modelId) : undefined

  return {
    status,
    modelId,
    modelName: readString(payload.modelName) ?? summary?.modelName ?? summary?.name ?? view.modelActivity.modelName,
    provider: readString(payload.provider) ?? summary?.provider ?? view.modelActivity.provider,
    reasoningEffort: readString(payload.reasoningEffort) ?? summary?.reasoningEffort ?? view.modelActivity.reasoningEffort ?? "medium",
    contextWindowTokens: readPositiveInteger(payload.contextWindowTokens) ?? summary?.contextWindowTokens ?? view.modelActivity.contextWindowTokens,
    usage,
  }
}

function readModelUsage(value: unknown): TuiState["modelActivity"]["usage"] {
  if (!isRecord(value)) return null
  return {
    inputTokens: readNonnegativeIntegerOrNull(value.inputTokens),
    outputTokens: readNonnegativeIntegerOrNull(value.outputTokens),
    totalTokens: readNonnegativeIntegerOrNull(value.totalTokens),
  }
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null
}

function readNullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : readString(value)
}

function readPositiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null
}

function readNonnegativeIntegerOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function appendRunLog(current: TuiState["runLog"], event: RunEvent): TuiState["runLog"] {
  const item = toRunLogItem(event)
  return item ? [...current, item] : current
}

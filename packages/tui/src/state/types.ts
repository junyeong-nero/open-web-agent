import type { Observation, RunEvent } from "@open-web-agent/core"
import type { RunLogItem } from "../log/run-log"

export interface ConversationMessage {
  role: "user" | "assistant" | "system"
  content: string
}

export interface TimelineItem {
  eventId: string
  sequence: number
  type: RunEvent["type"]
  label: string
}

export interface PlanItem {
  id: string
  title: string
  status: "pending" | "active" | "completed"
}

export interface AgentSummary {
  id: string
  name: string
  description: string
}

export interface ModelSummary {
  id: string
  name: string
  provider: string
}

export interface EnvironmentSummary {
  id: string
  name: string
}

export interface TuiState {
  projectPath: string
  activeSessionId: string | null
  activeRunId: string | null
  selectedAgentId: string
  selectedModelId: string | null
  selectedEnvironmentId: string
  selectedThemeId: string
  availableAgents: AgentSummary[]
  availableModels: ModelSummary[]
  availableEnvironments: EnvironmentSummary[]
  runStatus: "idle" | "running" | "completed" | "failed" | "cancelled"
  inspectorVisible: boolean
  selectedEvent: RunEvent | null
  conversation: ConversationMessage[]
  timeline: TimelineItem[]
  runLog: RunLogItem[]
  plan: PlanItem[]
  browser: Observation
}

export const EMPTY_OBSERVATION: Observation = {
  url: "about:blank",
  title: null,
  text: null,
  screenshotPath: null,
  interactiveElements: [],
  metadata: {},
}

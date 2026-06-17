import type { Observation, RunEvent } from "@open-web-agent/core"

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

export interface TuiState {
  projectPath: string
  activeSessionId: string | null
  activeRunId: string | null
  runStatus: "idle" | "running" | "completed" | "failed" | "cancelled"
  inspectorVisible: boolean
  selectedEvent: RunEvent | null
  conversation: ConversationMessage[]
  timeline: TimelineItem[]
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

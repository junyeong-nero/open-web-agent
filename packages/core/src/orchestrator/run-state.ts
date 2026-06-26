import type { AgentDecision } from "../contracts/agent"
import type { ActionResult, BrowserCapability, BrowserToolDefinition, Observation } from "../contracts/browser"
import type { RunEvent, RunEventType } from "../contracts/event"
import type { ModelToolResult } from "../contracts/model"
import type { EventBus } from "../events/event-bus"

export interface SessionState {
  id: string
  projectPath: string
  projectHash: string
  environmentId?: string | null
  title?: string | null
  pinned?: boolean
  deletedAt?: string | null
  createdAt: string
}

export interface AgentStepRecord {
  id: string
  decision: AgentDecision | null
  observation: Observation | null
  actionResults: ActionResult[]
  modelToolResults: ModelToolResult[]
}

export interface AgentState {
  session: SessionState
  runId: string
  prompt: string
  steps: AgentStepRecord[]
  lastObservation: Observation | null
  finalAnswer: string | null
}

export interface RuntimeContext {
  session: SessionState
  runId: string
  runDir: string
  agentId?: string
  modelId?: string
  environmentId?: string
  browserCapabilities: BrowserCapability[]
  browserTools: BrowserToolDefinition[]
  eventBus: EventBus
  abortSignal: AbortSignal
  now(): Date
  emit(type: RunEventType, payload: Record<string, unknown>, stepId?: string | null): Promise<RunEvent>
}

export interface RunResult {
  runId: string
  status: "completed" | "failed" | "cancelled"
  finalAnswer: string | null
}

export function toIsoString(date: Date): string {
  return date.toISOString()
}

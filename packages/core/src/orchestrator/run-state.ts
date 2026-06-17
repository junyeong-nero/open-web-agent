import type { AgentDecision } from "../contracts/agent"
import type { ActionResult, Observation } from "../contracts/browser"
import type { RunEvent, RunEventType } from "../contracts/event"

export interface SessionState {
  id: string
  projectPath: string
  projectHash: string
  createdAt: string
}

export interface AgentStepRecord {
  id: string
  decision: AgentDecision | null
  observation: Observation | null
  actionResults: ActionResult[]
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
  eventBus: unknown
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

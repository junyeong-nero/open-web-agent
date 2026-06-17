import type { AgentDecision } from "./agent"
import type { ActionResult, BrowserToolCall, Observation } from "./browser"
import type { ModelRequest, ModelResponse } from "./model"
import type { AgentState, RuntimeContext } from "../orchestrator/run-state"

export interface AgentPlugin {
  id: string
  name: string
  description: string
  initialize(ctx: RuntimeContext): Promise<void>
  step(state: AgentState, ctx: RuntimeContext): Promise<AgentDecision>
  finalize(state: AgentState, ctx: RuntimeContext): Promise<string>
}

export interface ModelPlugin {
  id: string
  name: string
  provider: string
  complete(request: ModelRequest, ctx: RuntimeContext): Promise<ModelResponse>
}

export interface BrowserEnvironment {
  id: string
  name: string
  reset(ctx: RuntimeContext): Promise<void>
  observe(ctx: RuntimeContext): Promise<Observation>
  execute(call: BrowserToolCall, ctx: RuntimeContext): Promise<ActionResult>
  close(ctx: RuntimeContext): Promise<void>
}

import type { AgentDecision } from "../contracts/agent"
import type { ActionResult } from "../contracts/browser"
import type { RunEvent, RunEventType } from "../contracts/event"
import type { EventBus } from "../events/event-bus"
import { makeEventId, makeRunId, makeStepId } from "../ids/ids"
import type { PluginRegistry } from "../registry/plugin-registry"
import { JsonlEventStore } from "../storage/jsonl-event-store"
import { eventsPath, runPath } from "../storage/paths"
import type { AgentState, RunResult, RuntimeContext, SessionState } from "./run-state"

export interface RunOrchestratorOptions {
  home: string
  eventBus: EventBus
  registry: PluginRegistry
  agentId: string
  environmentId: string
  maxSteps: number
  now?: () => Date
}

export interface StartRunInput {
  session: SessionState
  prompt: string
}

export interface StartedRun {
  runId: string
  result: Promise<RunResult>
}

export class RunOrchestrator {
  private readonly activeRuns = new Map<string, AbortController>()
  private readonly now: () => Date

  constructor(private readonly options: RunOrchestratorOptions) {
    this.now = options.now ?? (() => new Date())
  }

  startRun(input: StartRunInput): StartedRun {
    const runId = makeRunId()
    const abortController = new AbortController()
    this.activeRuns.set(runId, abortController)

    const result = this.executeRun(runId, input, abortController).finally(() => {
      this.activeRuns.delete(runId)
    })

    return { runId, result }
  }

  cancelRun(runId: string): boolean {
    const abortController = this.activeRuns.get(runId)
    if (!abortController) return false

    abortController.abort()
    return true
  }

  private async executeRun(
    runId: string,
    input: StartRunInput,
    abortController: AbortController,
  ): Promise<RunResult> {
    const agent = this.options.registry.getAgent(this.options.agentId)
    const environment = this.options.registry.getEnvironment(this.options.environmentId)
    const runDir = runPath(this.options.home, input.session.projectHash, input.session.id, runId)
    const eventStore = new JsonlEventStore(eventsPath(this.options.home, input.session.projectHash, input.session.id, runId))
    let sequence = 0

    const emit = async (
      type: RunEventType,
      payload: Record<string, unknown>,
      stepId: string | null = null,
    ): Promise<RunEvent> => {
      const event: RunEvent = {
        id: makeEventId(),
        runId,
        sessionId: input.session.id,
        stepId,
        sequence,
        type,
        payload,
        createdAt: this.now().toISOString(),
      }
      sequence += 1
      await eventStore.append(event)
      await this.options.eventBus.publish(event)
      return event
    }

    const ctx: RuntimeContext = {
      session: input.session,
      runId,
      runDir,
      eventBus: this.options.eventBus,
      abortSignal: abortController.signal,
      now: this.now,
      emit,
    }

    const state: AgentState = {
      session: input.session,
      runId,
      prompt: input.prompt,
      steps: [],
      lastObservation: null,
      finalAnswer: null,
    }

    try {
      throwIfAborted(abortController.signal)
      await environment.reset(ctx)
      await agent.initialize(ctx)

      await emit("session.created", { session: input.session })
      await emit("run.started", { prompt: input.prompt })

      state.lastObservation = await environment.observe(ctx)
      await emit("observation.captured", { observation: state.lastObservation })

      for (let stepIndex = 0; stepIndex < this.options.maxSteps; stepIndex += 1) {
        throwIfAborted(abortController.signal)
        const stepId = makeStepId()
        await emit("agent.step.started", { stepIndex }, stepId)

        const decision = await agent.step(state, ctx)
        const step = {
          id: stepId,
          decision,
          observation: state.lastObservation,
          actionResults: [] as ActionResult[],
        }

        await emit("agent.step.completed", { decision }, stepId)
        state.steps.push(step)

        if (decision.type === "final_answer") {
          state.finalAnswer = decision.finalAnswer
          const finalAnswer = await agent.finalize(state, ctx)
          state.finalAnswer = finalAnswer
          await emit("run.completed", { finalAnswer })
          return { runId, status: "completed", finalAnswer }
        }

        await this.executeBrowserActions(decision, stepId, step.actionResults, ctx)
        state.lastObservation = await environment.observe(ctx)
        step.observation = state.lastObservation
        await emit("observation.captured", { observation: state.lastObservation })
      }

      await emit("run.failed", { message: `Max steps exceeded: ${this.options.maxSteps}` })
      return { runId, status: "failed", finalAnswer: null }
    } catch (error) {
      if (isAbortError(error)) {
        await emit("run.cancelled", { reason: "Run cancelled" })
        return { runId, status: "cancelled", finalAnswer: null }
      }

      await emit("run.failed", { message: error instanceof Error ? error.message : String(error) })
      return { runId, status: "failed", finalAnswer: null }
    } finally {
      await environment.close(ctx)
    }
  }

  private async executeBrowserActions(
    decision: Extract<AgentDecision, { type: "browser_actions" }>,
    stepId: string,
    actionResults: ActionResult[],
    ctx: RuntimeContext,
  ): Promise<void> {
    const environment = this.options.registry.getEnvironment(this.options.environmentId)

    for (const action of decision.actions) {
      await ctx.emit("browser.action.started", { action }, stepId)

      for (const toolCall of action.toolCalls) {
        throwIfAborted(ctx.abortSignal)
        await ctx.emit("browser.tool.started", { actionId: action.id, toolCall }, stepId)
        const result = await environment.execute(toolCall, ctx)
        actionResults.push(result)
        await ctx.emit("browser.tool.completed", { actionId: action.id, toolCall, result }, stepId)

        if (!result.ok) {
          throw new Error(result.message ?? `Browser tool failed: ${toolCall.type}`)
        }
      }

      await ctx.emit("browser.action.completed", { action, actionResults }, stepId)
    }
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new DOMException("Run cancelled", "AbortError")
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError"
}

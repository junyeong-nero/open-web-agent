import { z } from "zod"
import type {
  AgentDecision,
  AgentPlugin,
  AgentState,
  ModelPlugin,
  ModelRequest,
  RuntimeContext,
} from "@open-web-agent/core"
import { formatObservationForPrompt, SimpleReActAgent } from "./simple-react-agent"

const PlanItemSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: z.enum(["pending", "active", "completed"]),
})

const PlanSchema = z.object({
  items: z.array(PlanItemSchema).min(1),
})

export type PlanItem = z.infer<typeof PlanItemSchema>

export interface PlanActAgentOptions {
  model: ModelPlugin
  modelName: string
  timeoutMs?: number
  maxParseRetries?: number
}

export class PlanActAgent implements AgentPlugin {
  id = "plan-act-agent"
  name = "PlanAct Agent"
  description = "Creates a visible plan before using ReAct browser actions."
  private readonly actionAgent: SimpleReActAgent
  private readonly timeoutMs: number

  constructor(private readonly options: PlanActAgentOptions) {
    this.timeoutMs = options.timeoutMs ?? 30_000
    this.actionAgent = new SimpleReActAgent(options)
  }

  async initialize(ctx: RuntimeContext): Promise<void> {
    await this.actionAgent.initialize(ctx)
  }

  async step(state: AgentState, ctx: RuntimeContext): Promise<AgentDecision> {
    if (state.steps.length === 0) {
      const plan = await this.createPlan(state, ctx, null)
      await ctx.emit("plan.created", { items: plan.items })
    } else if (lastStepFailed(state)) {
      const plan = await this.createPlan(state, ctx, "The previous browser action failed. Replan before continuing.")
      await ctx.emit("plan.updated", { items: plan.items, reason: "browser_action_failed" })
    }

    return this.actionAgent.step(state, ctx)
  }

  async finalize(state: AgentState, ctx: RuntimeContext): Promise<string> {
    return this.actionAgent.finalize(state, ctx)
  }

  private async createPlan(state: AgentState, ctx: RuntimeContext, reason: string | null): Promise<{ items: PlanItem[] }> {
    const request = this.buildPlanRequest(state, reason)
    const response = await withTimeout(this.options.model.complete(request, ctx), this.timeoutMs, ctx.abortSignal)
    return parsePlan(response.text)
  }

  private buildPlanRequest(state: AgentState, reason: string | null): ModelRequest {
    const failedResults = state.steps
      .flatMap((step) => step.actionResults)
      .filter((result) => !result.ok)
      .map((result) => result.message ?? "Browser action failed")
      .join("\n")

    return {
      model: this.options.modelName,
      responseFormat: "json",
      messages: [
        {
          role: "system",
          content: [
            "You are Open Web Agent's planning agent.",
            "Return only JSON with this shape:",
            '{"items":[{"id":string,"title":string,"status":"pending"|"active"|"completed"}]}',
            "Use concise user-visible task titles.",
          ].join("\n"),
        },
        {
          role: "user",
          content: [
            `Task: ${state.prompt}`,
            "",
            "Current observation:",
            formatObservationForPrompt(state.lastObservation),
            "",
            `Completed steps: ${state.steps.length}`,
            ...(reason ? ["", `Planning reason: ${reason}`] : []),
            ...(failedResults ? ["", "Failed browser results:", failedResults] : []),
          ].join("\n"),
        },
      ],
    }
  }
}

function parsePlan(text: string): { items: PlanItem[] } {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new Error(`Model returned invalid plan JSON: ${error instanceof Error ? error.message : String(error)}`)
  }

  return PlanSchema.parse(parsed)
}

function lastStepFailed(state: AgentState): boolean {
  const lastStep = state.steps.at(-1)
  return lastStep ? lastStep.actionResults.some((result) => !result.ok) : false
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new DOMException("Run cancelled", "AbortError"))

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Model call timed out after ${timeoutMs}ms`)), timeoutMs)
    const onAbort = () => reject(new DOMException("Run cancelled", "AbortError"))

    signal.addEventListener("abort", onAbort, { once: true })
    promise.then(
      (value) => {
        clearTimeout(timeout)
        signal.removeEventListener("abort", onAbort)
        resolve(value)
      },
      (error) => {
        clearTimeout(timeout)
        signal.removeEventListener("abort", onAbort)
        reject(error)
      },
    )
  })
}

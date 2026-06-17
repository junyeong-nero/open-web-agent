import { spawn } from "node:child_process"
import { z } from "zod"
import {
  AgentDecisionSchema,
  RunEventTypeSchema,
  type AgentDecision,
  type AgentPlugin,
  type AgentState,
  type RuntimeContext,
  type RunEventType,
} from "@open-web-agent/core"

export interface PythonAgentAdapterOptions {
  id: string
  name: string
  description: string
  command: string[]
  cwd?: string
  env?: Record<string, string>
  timeoutMs?: number
}

type PythonAgentMethod = "initialize" | "step" | "finalize"

interface SerializableRuntimeContext {
  session: RuntimeContext["session"]
  runId: string
  runDir: string
  agentId: string | null
  modelId: string | null
  environmentId: string | null
  now: string
}

const PythonAgentEventSchema = z.object({
  type: RunEventTypeSchema,
  payload: z.record(z.string(), z.unknown()).default({}),
  stepId: z.string().nullable().optional(),
})

const InitializeResponseSchema = z.object({
  ok: z.boolean().optional(),
  events: z.array(PythonAgentEventSchema).optional(),
})

const StepResponseSchema = z.object({
  decision: AgentDecisionSchema,
  events: z.array(PythonAgentEventSchema).optional(),
})

const FinalizeResponseSchema = z.object({
  finalAnswer: z.string(),
  events: z.array(PythonAgentEventSchema).optional(),
})

export class PythonAgentAdapter implements AgentPlugin {
  id: string
  name: string
  description: string
  private readonly command: string[]
  private readonly cwd: string | undefined
  private readonly env: Record<string, string> | undefined
  private readonly timeoutMs: number

  constructor(options: PythonAgentAdapterOptions) {
    if (options.command.length === 0) throw new Error(`Python agent ${options.id} command must not be empty`)

    this.id = options.id
    this.name = options.name
    this.description = options.description
    this.command = options.command
    this.cwd = options.cwd
    this.env = options.env
    this.timeoutMs = options.timeoutMs ?? 30_000
  }

  async initialize(ctx: RuntimeContext): Promise<void> {
    const response = InitializeResponseSchema.parse(
      await this.callPython(
        "initialize",
        {
          method: "initialize",
          agent: this.agentMetadata(),
          context: serializeContext(ctx),
        },
        ctx.abortSignal,
      ),
    )
    await emitPythonEvents(ctx, response.events)
  }

  async step(state: AgentState, ctx: RuntimeContext): Promise<AgentDecision> {
    const response = StepResponseSchema.parse(
      await this.callPython(
        "step",
        {
          method: "step",
          agent: this.agentMetadata(),
          state,
          context: serializeContext(ctx),
        },
        ctx.abortSignal,
      ),
    )
    await emitPythonEvents(ctx, response.events)
    return response.decision
  }

  async finalize(state: AgentState, ctx: RuntimeContext): Promise<string> {
    const response = FinalizeResponseSchema.parse(
      await this.callPython(
        "finalize",
        {
          method: "finalize",
          agent: this.agentMetadata(),
          state,
          context: serializeContext(ctx),
        },
        ctx.abortSignal,
      ),
    )
    await emitPythonEvents(ctx, response.events)
    return response.finalAnswer
  }

  private agentMetadata(): { id: string; name: string; description: string } {
    return {
      id: this.id,
      name: this.name,
      description: this.description,
    }
  }

  private callPython(method: PythonAgentMethod, request: Record<string, unknown>, abortSignal: AbortSignal): Promise<unknown> {
    const [executable, ...args] = this.command
    if (!executable) throw new Error(`Python agent ${this.id} command must not be empty`)
    if (abortSignal.aborted) return Promise.reject(new DOMException("Run cancelled", "AbortError"))

    return new Promise((resolve, reject) => {
      const child = spawn(executable, args, {
        cwd: this.cwd,
        env: { ...process.env, ...this.env },
        stdio: ["pipe", "pipe", "pipe"],
      })
      let stdout = ""
      let stderr = ""
      let settled = false

      const timeout = setTimeout(() => {
        fail(new Error(`Python agent ${this.id} ${method} timed out after ${this.timeoutMs}ms`))
        child.kill()
      }, this.timeoutMs)

      const cleanup = () => {
        clearTimeout(timeout)
        abortSignal.removeEventListener("abort", onAbort)
      }

      const fail = (error: Error) => {
        if (settled) return
        settled = true
        cleanup()
        reject(error)
      }

      const onAbort = () => {
        child.kill()
        fail(new DOMException("Run cancelled", "AbortError"))
      }

      abortSignal.addEventListener("abort", onAbort, { once: true })

      child.stdout.setEncoding("utf8")
      child.stderr.setEncoding("utf8")
      child.stdout.on("data", (chunk) => {
        stdout += chunk
      })
      child.stderr.on("data", (chunk) => {
        stderr += chunk
      })
      child.on("error", (error) => {
        fail(new Error(`Python agent ${this.id} ${method} failed to start: ${error.message}`))
      })
      child.on("close", (code, signal) => {
        if (settled) return
        settled = true
        cleanup()

        if (code !== 0) {
          const details = stderr.trim() || `signal ${signal ?? "unknown"}`
          reject(new Error(`Python agent ${this.id} ${method} failed with exit code ${code ?? "null"}: ${details}`))
          return
        }

        try {
          resolve(JSON.parse(stdout))
        } catch (error) {
          reject(
            new Error(
              `Python agent ${this.id} ${method} returned invalid JSON: ${
                error instanceof Error ? error.message : String(error)
              }`,
            ),
          )
        }
      })

      child.stdin.end(JSON.stringify(request))
    })
  }
}

function serializeContext(ctx: RuntimeContext): SerializableRuntimeContext {
  return {
    session: ctx.session,
    runId: ctx.runId,
    runDir: ctx.runDir,
    agentId: ctx.agentId ?? null,
    modelId: ctx.modelId ?? null,
    environmentId: ctx.environmentId ?? null,
    now: ctx.now().toISOString(),
  }
}

async function emitPythonEvents(
  ctx: RuntimeContext,
  events: Array<{ type: RunEventType; payload: Record<string, unknown>; stepId?: string | null }> | undefined,
): Promise<void> {
  for (const event of events ?? []) {
    await ctx.emit(event.type, event.payload, event.stepId ?? null)
  }
}

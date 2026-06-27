import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { z } from "zod"
import {
  AgentDecisionSchema,
  ModelRequestSchema,
  RunEventTypeSchema,
  type AgentDecision,
  type AgentPlugin,
  type AgentState,
  type ModelPlugin,
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
  protocol?: "oneshot" | "jsonl"
  model?: ModelPlugin
  maxStepResponseRetries?: number
}

type PythonAgentMethod = "initialize" | "step" | "finalize"
type PythonChildProcess = ChildProcessWithoutNullStreams & {
  on(event: "error", listener: (error: Error) => void): PythonChildProcess
  on(event: "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): PythonChildProcess
}

interface PythonAgentRetryContext {
  attempt: number
  previousError: string
  previousResponse: unknown
}

interface SerializableRuntimeContext {
  session: RuntimeContext["session"]
  runId: string
  runDir: string
  agentId: string | null
  modelId: string | null
  environmentId: string | null
  browserCapabilities: RuntimeContext["browserCapabilities"]
  browserTools: RuntimeContext["browserTools"]
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

const PythonAgentCommandSchema = z.object({
  command: z.literal("model.complete"),
  id: z.string().min(1),
  request: ModelRequestSchema,
})

export class PythonAgentAdapter implements AgentPlugin {
  id: string
  name: string
  description: string
  private readonly command: string[]
  private readonly cwd: string | undefined
  private readonly env: Record<string, string> | undefined
  private readonly timeoutMs: number
  private readonly protocol: "oneshot" | "jsonl"
  private readonly model: ModelPlugin | undefined
  private readonly maxStepResponseRetries: number

  constructor(options: PythonAgentAdapterOptions) {
    if (options.command.length === 0) throw new Error(`Python agent ${options.id} command must not be empty`)

    this.id = options.id
    this.name = options.name
    this.description = options.description
    this.command = options.command
    this.cwd = options.cwd
    this.env = options.env
    this.timeoutMs = options.timeoutMs ?? 30_000
    this.protocol = options.protocol ?? "oneshot"
    this.model = options.model
    this.maxStepResponseRetries = options.maxStepResponseRetries ?? 1
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
        ctx,
      ),
    )
    await emitPythonEvents(ctx, response.events)
  }

  async step(state: AgentState, ctx: RuntimeContext): Promise<AgentDecision> {
    let retry: PythonAgentRetryContext | undefined
    let lastError = ""

    for (let attempt = 0; attempt <= this.maxStepResponseRetries; attempt += 1) {
      const response = await this.callPython(
        "step",
        {
          method: "step",
          agent: this.agentMetadata(),
          state,
          context: serializeContext(ctx),
          ...(retry ? { retry } : {}),
        },
        ctx,
      )
      const parsed = StepResponseSchema.safeParse(response)
      if (parsed.success) {
        await emitPythonEvents(ctx, parsed.data.events)
        return parsed.data.decision
      }

      lastError = parsed.error.message
      if (attempt >= this.maxStepResponseRetries) break
      retry = {
        attempt: attempt + 1,
        previousError: lastError,
        previousResponse: response,
      }
    }

    throw new Error(`Python agent ${this.id} step returned invalid decision after retry: ${lastError}`)
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
        ctx,
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

  private callPython(method: PythonAgentMethod, request: Record<string, unknown>, ctx: RuntimeContext): Promise<unknown> {
    if (this.protocol === "jsonl") return this.callPythonJsonl(method, request, ctx)
    return this.callPythonOneshot(method, request, ctx.abortSignal)
  }

  private callPythonOneshot(
    method: PythonAgentMethod,
    request: Record<string, unknown>,
    abortSignal: AbortSignal,
  ): Promise<unknown> {
    const [executable, ...args] = this.command
    if (!executable) throw new Error(`Python agent ${this.id} command must not be empty`)
    if (abortSignal.aborted) return Promise.reject(new DOMException("Run cancelled", "AbortError"))

    return new Promise((resolve, reject) => {
      const child = spawn(executable, args, {
        cwd: this.cwd,
        env: { ...process.env, ...this.env },
        stdio: ["pipe", "pipe", "pipe"],
      }) as PythonChildProcess
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

  private callPythonJsonl(method: PythonAgentMethod, request: Record<string, unknown>, ctx: RuntimeContext): Promise<unknown> {
    const [executable, ...args] = this.command
    if (!executable) throw new Error(`Python agent ${this.id} command must not be empty`)
    if (ctx.abortSignal.aborted) return Promise.reject(new DOMException("Run cancelled", "AbortError"))

    return new Promise((resolve, reject) => {
      const child = spawn(executable, args, {
        cwd: this.cwd,
        env: { ...process.env, ...this.env },
        stdio: ["pipe", "pipe", "pipe"],
      }) as PythonChildProcess
      let stdoutBuffer = ""
      let stderr = ""
      let finalResponse: unknown
      let hasFinalResponse = false
      let settled = false

      const timeout = setTimeout(() => {
        fail(new Error(`Python agent ${this.id} ${method} timed out after ${this.timeoutMs}ms`))
      }, this.timeoutMs)

      const cleanup = () => {
        clearTimeout(timeout)
        ctx.abortSignal.removeEventListener("abort", onAbort)
      }

      const fail = (error: Error) => {
        if (settled) return
        settled = true
        cleanup()
        child.kill()
        reject(error)
      }

      const writeJsonLine = (value: unknown) => {
        if (settled || child.stdin.destroyed || !child.stdin.writable) return
        child.stdin.write(`${JSON.stringify(value)}\n`)
      }

      const handleCommand = async (value: unknown) => {
        const parsed = PythonAgentCommandSchema.safeParse(value)
        if (!parsed.success) {
          fail(new Error(`Python agent ${this.id} ${method} returned invalid command: ${parsed.error.message}`))
          return
        }

        if (!this.model) {
          writeJsonLine({
            id: parsed.data.id,
            ok: false,
            error: "No runtime model is configured for Python agent command model.complete",
          })
          return
        }

        try {
          const response = await this.model.complete(parsed.data.request, ctx)
          writeJsonLine({ id: parsed.data.id, ok: true, response })
        } catch (error) {
          writeJsonLine({
            id: parsed.data.id,
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          })
        }
      }

      const handleLine = (line: string) => {
        const trimmed = line.trim()
        if (!trimmed) return

        let parsed: unknown
        try {
          parsed = JSON.parse(trimmed)
        } catch (error) {
          fail(
            new Error(
              `Python agent ${this.id} ${method} returned invalid JSON line: ${
                error instanceof Error ? error.message : String(error)
              }`,
            ),
          )
          return
        }

        if (isRecord(parsed) && typeof parsed.command === "string") {
          void handleCommand(parsed)
          return
        }

        finalResponse = parsed
        hasFinalResponse = true
        child.stdin.end()
      }

      const flushStdoutLines = () => {
        let newlineIndex = stdoutBuffer.indexOf("\n")
        while (newlineIndex >= 0) {
          const line = stdoutBuffer.slice(0, newlineIndex)
          stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1)
          handleLine(line)
          newlineIndex = stdoutBuffer.indexOf("\n")
        }
      }

      const onAbort = () => {
        fail(new DOMException("Run cancelled", "AbortError"))
      }

      ctx.abortSignal.addEventListener("abort", onAbort, { once: true })

      child.stdout.setEncoding("utf8")
      child.stderr.setEncoding("utf8")
      child.stdout.on("data", (chunk) => {
        stdoutBuffer += chunk
        flushStdoutLines()
      })
      child.stderr.on("data", (chunk) => {
        stderr += chunk
      })
      child.on("error", (error) => {
        fail(new Error(`Python agent ${this.id} ${method} failed to start: ${error.message}`))
      })
      child.on("close", (code, signal) => {
        if (settled) return
        if (stdoutBuffer.trim()) {
          handleLine(stdoutBuffer)
          stdoutBuffer = ""
        }
        if (settled) return
        settled = true
        cleanup()

        if (code !== 0) {
          const details = stderr.trim() || `signal ${signal ?? "unknown"}`
          reject(new Error(`Python agent ${this.id} ${method} failed with exit code ${code ?? "null"}: ${details}`))
          return
        }

        if (!hasFinalResponse) {
          reject(new Error(`Python agent ${this.id} ${method} exited without a final JSON response`))
          return
        }

        resolve(finalResponse)
      })

      writeJsonLine(request)
    })
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function serializeContext(ctx: RuntimeContext): SerializableRuntimeContext {
  return {
    session: ctx.session,
    runId: ctx.runId,
    runDir: ctx.runDir,
    agentId: ctx.agentId ?? null,
    modelId: ctx.modelId ?? null,
    environmentId: ctx.environmentId ?? null,
    browserCapabilities: ctx.browserCapabilities,
    browserTools: ctx.browserTools,
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

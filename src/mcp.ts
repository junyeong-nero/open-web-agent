import { createInterface } from "node:readline"
import { z } from "zod"
import { interruptible } from "./cancel"
import { runAgent, taskIncomplete } from "./agent"
import type { BrowserSession } from "./browser"
import type { ModelAdapter } from "./model/types"
import { type BrowserTool, callTool, type ToolResult, toolSpec } from "./tools"
import { VERSION } from "./version"

const SUPPORTED_PROTOCOLS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"]

const JsonRpcRequestSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number(), z.null()]).optional(),
  method: z.string(),
  params: z.record(z.string(), z.unknown()).optional(),
})
type JsonRpcRequest = z.infer<typeof JsonRpcRequestSchema>

export interface McpServerOptions {
  session: BrowserSession
  tools: BrowserTool[]
  /** When set, exposes `browser_task`, which delegates a whole task to the built-in agent on this model. */
  agentModel?: ModelAdapter
  /** Checks a `browser_task` answer that claims success; see `AgentOptions.judgeModel`. */
  agentJudgeModel?: ModelAdapter
  /** Checks the page from a screenshot during `browser_task`; see `AgentOptions.visionModel`. The tool list stays the same. */
  agentVisionModel?: ModelAdapter
  agentMaxSteps?: number
  agentTimeoutMs?: number
}

const BrowserTaskSchema = z.object({
  task: z.string().describe("What to do and what to return, e.g. 'Find the price of the Pro plan on example.com'"),
  maxSteps: z.number().int().positive().max(100).optional(),
  timeoutMs: z.number().int().positive().max(2_147_483_647).optional(),
})

/** Minimal MCP server: initialize, ping, tools/list, tools/call. Transport-agnostic. */
export function createMcpServer(options: McpServerOptions) {
  // Browser tools share one page, so calls run strictly one at a time.
  let queue: Promise<unknown> = Promise.resolve()
  const controllers = new Map<string | number, AbortController>()
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const next = queue.then(work, work)
    queue = next.catch(() => {})
    return next
  }

  const listTools = () => {
    const tools = options.tools.map((definition) => ({
      ...toolSpec(definition),
      annotations: { readOnlyHint: definition.readOnly, destructiveHint: false, openWorldHint: true },
    }))
    if (options.agentModel) {
      const { $schema: _ignored, ...inputSchema } = z.toJSONSchema(BrowserTaskSchema) as Record<string, unknown>
      tools.push({
        name: "browser_task",
        description: `Delegate a complete web task to Open Web Agent's own browser agent (model: ${options.agentModel.name}). It browses on its own and returns only the final answer, keeping page snapshots out of your context.`,
        inputSchema,
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      })
    }
    return { tools }
  }

  const callBrowserTask = async (args: unknown, signal?: AbortSignal): Promise<ToolResult> => {
    const parsed = BrowserTaskSchema.safeParse(args ?? {})
    if (!parsed.success) return { text: z.prettifyError(parsed.error), isError: true }
    let result: Awaited<ReturnType<typeof runAgent>>
    try {
      result = await runAgent({
        task: parsed.data.task,
        model: options.agentModel as ModelAdapter,
        browser: options.session,
        tools: options.tools,
        maxSteps: parsed.data.maxSteps ?? options.agentMaxSteps,
        timeoutMs: parsed.data.timeoutMs ?? options.agentTimeoutMs,
        judgeModel: options.agentJudgeModel,
        visionModel: options.agentVisionModel,
        signal,
      })
    } catch (error) {
      return { text: `browser_task failed: ${error instanceof Error ? error.message : String(error)}`, isError: true }
    }
    const judgeTokens = result.judgeUsage ? `, judge tokens: ${result.judgeUsage.inputTokens} in / ${result.judgeUsage.outputTokens} out` : ""
    const visionTokens = result.visionUsage ? `, vision tokens: ${result.visionUsage.inputTokens} in / ${result.visionUsage.outputTokens} out` : ""
    return {
      text: `${result.answer || result.error || "No answer returned"}\n\n[status: ${result.status}, steps: ${result.steps}]\n[stop: ${result.stopReason}, outcome: ${result.outcome.status} (${result.outcome.verification}), duration: ${result.durationMs}ms, tokens: ${result.usage.inputTokens} in / ${result.usage.outputTokens} out${judgeTokens}${visionTokens}]${result.outcome.unfinished.length ? `\nUnfinished: ${result.outcome.unfinished.join("; ")}` : ""}${result.observedUrls.length ? `\nObserved URLs (not verified citations): ${result.observedUrls.join(", ")}` : ""}`,
      structuredContent: { ...result },
      isError: taskIncomplete(result),
    }
  }

  const callToolRequest = async (params: Record<string, unknown> | undefined, signal?: AbortSignal) => {
    const name = String(params?.name ?? "")
    const args = params?.arguments
    const result = await serial(async () => {
      if (name === "browser_task" && options.agentModel) return callBrowserTask(args, signal)
      if (signal?.aborted) return { text: "Request cancelled before execution", isError: true }
      if (!signal) return callTool(options.tools, options.session, name, args)
      try {
        return await interruptible(() => callTool(options.tools, options.session, name, args), signal, pending => options.session.cancelPending(pending))
      } catch (error) {
        if (signal.aborted) return { text: "Request cancelled", isError: true }
        throw error
      }
    })
    const content: unknown[] = [{ type: "text", text: result.snapshot ? `${result.text}\n\n${result.snapshot}` : result.text }]
    if (result.image) content.push({ type: "image", mimeType: result.image.mimeType, data: result.image.data })
    return { content, isError: result.isError ?? false, ...(result.structuredContent ? { structuredContent: result.structuredContent } : {}) }
  }

  return {
    /** Handle one JSON-RPC message; returns the response, or undefined for notifications. */
    async handle(input: unknown): Promise<Record<string, unknown> | undefined> {
      const parsed = JsonRpcRequestSchema.safeParse(input)
      if (!parsed.success) return { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } }
      const message = parsed.data
      const isNotification = message.id === undefined
      if (isNotification && message.method === "notifications/cancelled") {
        const id = message.params?.requestId
        if (typeof id === "string" || typeof id === "number") controllers.get(id)?.abort(new Error("Request cancelled by MCP client"))
        return
      }
      const controller = message.method === "tools/call" && message.id != null ? new AbortController() : undefined
      if (controller) controllers.set(message.id as string | number, controller)
      try {
        const result = await dispatch(message, controller?.signal)
        return isNotification ? undefined : { jsonrpc: "2.0", id: message.id, result }
      } catch (error) {
        if (isNotification) return undefined
        const code = error instanceof MethodNotFound ? -32601 : -32603
        return { jsonrpc: "2.0", id: message.id, error: { code, message: error instanceof Error ? error.message : String(error) } }
      } finally {
        if (controller) controllers.delete(message.id as string | number)
      }
    },
  }

  async function dispatch(message: JsonRpcRequest, signal?: AbortSignal): Promise<unknown> {
    switch (message.method) {
      case "initialize": {
        const requested = String(message.params?.protocolVersion ?? "")
        return {
          protocolVersion: SUPPORTED_PROTOCOLS.includes(requested) ? requested : SUPPORTED_PROTOCOLS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "open-web-agent", version: VERSION },
          instructions:
            "Browser tools act on [ref=…] handles from the latest page snapshot. Action tools return a fresh snapshot.",
        }
      }
      case "ping":
        return {}
      case "tools/list":
        return listTools()
      case "tools/call":
        return callToolRequest(message.params, signal)
      default:
        if (message.method.startsWith("notifications/")) return {}
        throw new MethodNotFound(message.method)
    }
  }
}

class MethodNotFound extends Error {
  constructor(method: string) {
    super(`Method not found: ${method}`)
  }
}

/** Newline-delimited JSON-RPC over stdio. Resolves when stdin closes. */
export async function serveStdio(
  server: ReturnType<typeof createMcpServer>,
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
): Promise<void> {
  const write = (payload: unknown) => output.write(`${JSON.stringify(payload)}\n`)
  const pending = new Set<Promise<void>>()

  for await (const line of createInterface({ input, crlfDelay: Infinity })) {
    if (!line.trim()) continue
    let message: JsonRpcRequest
    try {
      message = JSON.parse(line)
    } catch {
      write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } })
      continue
    }
    const work = server.handle(message).catch(() => ({
      jsonrpc: "2.0", id: null, error: { code: -32603, message: "Internal error" },
    })).then((response) => {
      if (response) write(response)
    })
    pending.add(work)
    // Handle both paths; finally() would create another unhandled rejected promise.
    void work.then(() => pending.delete(work), () => pending.delete(work))
  }
  await Promise.all(pending)
}

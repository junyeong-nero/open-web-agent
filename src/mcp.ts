import { createInterface } from "node:readline"
import { z } from "zod"
import { runAgent } from "./agent"
import type { BrowserSession } from "./browser"
import type { ModelAdapter } from "./model/types"
import { type BrowserTool, callTool, type ToolResult, toolSpec } from "./tools"
import { VERSION } from "./version"

const SUPPORTED_PROTOCOLS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"]

interface JsonRpcRequest {
  jsonrpc: "2.0"
  id?: string | number | null
  method: string
  params?: Record<string, unknown>
}

export interface McpServerOptions {
  session: BrowserSession
  tools: BrowserTool[]
  /** When set, exposes `browser_task`, which delegates a whole task to the built-in agent on this model. */
  agentModel?: ModelAdapter
  agentMaxSteps?: number
}

const BrowserTaskSchema = z.object({
  task: z.string().describe("What to do and what to return, e.g. 'Find the price of the Pro plan on example.com'"),
  maxSteps: z.number().int().positive().max(100).optional(),
})

/** Minimal MCP server: initialize, ping, tools/list, tools/call. Transport-agnostic. */
export function createMcpServer(options: McpServerOptions) {
  // Browser tools share one page, so calls run strictly one at a time.
  let queue: Promise<unknown> = Promise.resolve()
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

  const callBrowserTask = async (args: unknown): Promise<ToolResult> => {
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
      })
    } catch (error) {
      return { text: `browser_task failed: ${error instanceof Error ? error.message : String(error)}`, isError: true }
    }
    return {
      text: `${result.answer}\n\n[status: ${result.status}, steps: ${result.steps}]`,
      isError: result.status === "failed",
    }
  }

  const callToolRequest = async (params: Record<string, unknown> | undefined) => {
    const name = String(params?.name ?? "")
    const args = params?.arguments
    const result = await serial(() =>
      name === "browser_task" && options.agentModel
        ? callBrowserTask(args)
        : callTool(options.tools, options.session, name, args),
    )
    const content: unknown[] = [{ type: "text", text: result.snapshot ? `${result.text}\n\n${result.snapshot}` : result.text }]
    if (result.image) content.push({ type: "image", mimeType: result.image.mimeType, data: result.image.data })
    return { content, isError: result.isError ?? false }
  }

  return {
    /** Handle one JSON-RPC message; returns the response, or undefined for notifications. */
    async handle(message: JsonRpcRequest): Promise<Record<string, unknown> | undefined> {
      const isNotification = message.id === undefined
      try {
        const result = await dispatch(message)
        return isNotification ? undefined : { jsonrpc: "2.0", id: message.id, result }
      } catch (error) {
        if (isNotification) return undefined
        const code = error instanceof MethodNotFound ? -32601 : -32603
        return { jsonrpc: "2.0", id: message.id, error: { code, message: error instanceof Error ? error.message : String(error) } }
      }
    },
  }

  async function dispatch(message: JsonRpcRequest): Promise<unknown> {
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
        return callToolRequest(message.params)
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
    const work = server.handle(message).then((response) => {
      if (response) write(response)
    })
    pending.add(work)
    void work.finally(() => pending.delete(work))
  }
  await Promise.all(pending)
}

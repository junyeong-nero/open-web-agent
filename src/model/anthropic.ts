import {
  type ContentPart,
  type FetchLike,
  type ModelAdapter,
  type ModelRequest,
  type ModelResponse,
  parseToolArguments,
  postJson,
  reportedUsage,
} from "./types"

export interface AnthropicMessagesOptions {
  model: string
  baseUrl?: string
  apiKey?: string
  maxTokens?: number
  headers?: Record<string, string>
  /** Merged into every request body, e.g. `{ temperature: 0 }` or `{ thinking: {...} }`. */
  extraBody?: Record<string, unknown>
  fetch?: FetchLike
}

/** Marks the end of a prefix for Anthropic's prompt cache, with the default five-minute lifetime. */
const CACHE_BREAKPOINT = { cache_control: { type: "ephemeral" } }

/** Anthropic Messages wire format. */
export function anthropicMessages(options: AnthropicMessagesOptions): ModelAdapter {
  const baseUrl = (options.baseUrl ?? "https://api.anthropic.com/v1").replace(/\/+$/, "")
  const fetchImpl = options.fetch ?? fetch
  const name = `anthropic-messages:${options.model}`

  return {
    name,
    async complete(request: ModelRequest): Promise<ModelResponse> {
      let system: string | unknown[] = request.system
      const messages = toAnthropicMessages(request)
      const tools: Array<Record<string, unknown>> = request.tools.map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.inputSchema }))
      // Only a request with a cache key gets breakpoints, and model options that set cache_control choose their own.
      if (request.cacheKey && !Object.hasOwn(options.extraBody ?? {}, "cache_control")) {
        // The cache covers tools, then system, then messages. One breakpoint ends the static prefix, on the last tool
        // when the system prompt is empty, since an empty text block cannot hold one.
        if (request.system) system = [{ type: "text", text: request.system, ...CACHE_BREAKPOINT }]
        else if (tools.length > 0) tools.push({ ...tools.pop(), ...CACHE_BREAKPOINT })
        // The other ends the message before the newest turn. The next request of an agent loop may send that turn
        // differently (owa reduces a superseded snapshot to a digest) but keeps the turns before it, so it reads them back.
        const previous = messages.at(-2)?.content
        if (previous?.length) previous.push({ ...(previous.pop() as object), ...CACHE_BREAKPOINT })
      }
      const body = {
        model: options.model,
        max_tokens: options.maxTokens ?? 4096,
        system,
        messages,
        ...(tools.length > 0 ? { tools } : {}),
        ...options.extraBody,
      }
      const headers: Record<string, string> = { "anthropic-version": "2023-06-01", ...options.headers }
      if (options.apiKey) headers["x-api-key"] = options.apiKey

      const json = (await postJson(fetchImpl, name, `${baseUrl}/messages`, headers, body, request.signal)) as {
        model?: string
        content?: Array<{ type: string; text?: string; id?: string; name?: string; input?: unknown }>
        stop_reason?: string
        usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null }
      }
      const blocks = json.content ?? []
      const text = blocks
        .filter((block) => block.type === "text" && block.text)
        .map((block) => block.text)
        .join("\n")
      const usage = reportedUsage({
        inputTokens: json.usage?.input_tokens,
        outputTokens: json.usage?.output_tokens,
        cachedInputTokens: json.usage?.cache_read_input_tokens,
        cacheWriteTokens: json.usage?.cache_creation_input_tokens,
      })
      // input_tokens leaves out cache reads and writes; add them so inputTokens is the total input, as in the OpenAI format.
      if (usage?.inputTokens !== undefined) usage.inputTokens += (usage.cachedInputTokens ?? 0) + (usage.cacheWriteTokens ?? 0)

      return {
        text: text || undefined,
        finishReason: json.stop_reason,
        toolCalls: blocks
          .filter((block) => block.type === "tool_use")
          .map((block) => ({ id: block.id ?? "", name: block.name ?? "", arguments: parseToolArguments(block.input) })),
        model: json.model || undefined,
        usage,
      }
    },
  }
}

interface AnthropicMessage {
  role: "user" | "assistant"
  content: unknown[]
}

function toAnthropicMessages(request: ModelRequest): AnthropicMessage[] {
  const out: AnthropicMessage[] = []
  // Tool results travel inside user turns; consecutive user-side content is merged into one turn.
  const pushUser = (blocks: unknown[]) => {
    const last = out.at(-1)
    if (last?.role === "user") last.content.push(...blocks)
    else out.push({ role: "user", content: blocks })
  }

  for (const message of request.messages) {
    if (message.role === "user") {
      pushUser(message.content.map(toBlock))
    } else if (message.role === "assistant") {
      const content: unknown[] = []
      if (message.text) content.push({ type: "text", text: message.text })
      for (const call of message.toolCalls) {
        content.push({ type: "tool_use", id: call.id, name: call.name, input: call.arguments })
      }
      out.push({ role: "assistant", content: content.length > 0 ? content : [{ type: "text", text: "(empty)" }] })
    } else {
      pushUser([
        {
          type: "tool_result",
          tool_use_id: message.toolCallId,
          content: message.content.map(toBlock),
          ...(message.isError ? { is_error: true } : {}),
        },
      ])
    }
  }
  return out
}

function toBlock(part: ContentPart): unknown {
  return part.type === "text"
    ? { type: "text", text: part.text }
    : { type: "image", source: { type: "base64", media_type: part.mimeType, data: part.data } }
}

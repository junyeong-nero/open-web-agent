import {
  type ContentPart,
  type FetchLike,
  type ModelAdapter,
  type ModelRequest,
  type ModelResponse,
  parseToolArguments,
  postJson,
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

/** Anthropic Messages wire format. */
export function anthropicMessages(options: AnthropicMessagesOptions): ModelAdapter {
  const baseUrl = (options.baseUrl ?? "https://api.anthropic.com/v1").replace(/\/+$/, "")
  const fetchImpl = options.fetch ?? fetch
  const name = `anthropic-messages:${options.model}`

  return {
    name,
    async complete(request: ModelRequest): Promise<ModelResponse> {
      const body = {
        model: options.model,
        max_tokens: options.maxTokens ?? 4096,
        system: request.system,
        messages: toAnthropicMessages(request),
        ...(request.tools.length > 0
          ? {
              tools: request.tools.map((tool) => ({
                name: tool.name,
                description: tool.description,
                input_schema: tool.inputSchema,
              })),
            }
          : {}),
        ...options.extraBody,
      }
      const headers: Record<string, string> = { "anthropic-version": "2023-06-01", ...options.headers }
      if (options.apiKey) headers["x-api-key"] = options.apiKey

      const json = (await postJson(fetchImpl, name, `${baseUrl}/messages`, headers, body, request.signal)) as {
        content?: Array<{ type: string; text?: string; id?: string; name?: string; input?: unknown }>
        stop_reason?: string
        usage?: { input_tokens?: number; output_tokens?: number }
      }
      const blocks = json.content ?? []
      const text = blocks
        .filter((block) => block.type === "text" && block.text)
        .map((block) => block.text)
        .join("\n")

      return {
        text: text || undefined,
        finishReason: json.stop_reason,
        toolCalls: blocks
          .filter((block) => block.type === "tool_use")
          .map((block) => ({ id: block.id ?? "", name: block.name ?? "", arguments: parseToolArguments(block.input) })),
        usage: json.usage ? { inputTokens: json.usage.input_tokens, outputTokens: json.usage.output_tokens } : undefined,
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

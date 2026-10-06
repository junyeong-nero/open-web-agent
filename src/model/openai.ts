import {
  type ContentPart,
  type FetchLike,
  type Message,
  type ModelAdapter,
  type ModelRequest,
  type ModelResponse,
  ModelHttpError,
  parseToolArguments,
  postJson,
  reportedUsage,
} from "./types"

export interface OpenAIChatOptions {
  model: string
  baseUrl?: string
  apiKey?: string
  headers?: Record<string, string>
  /** Merged into every request body, e.g. `{ temperature: 0 }` or `{ reasoning_effort: "low" }`. */
  extraBody?: Record<string, unknown>
  fetch?: FetchLike
}

/** OpenAI Chat Completions wire format. Also serves OpenRouter, Gemini's OpenAI endpoint, Ollama, vLLM, … */
export function openaiChat(options: OpenAIChatOptions): ModelAdapter {
  const baseUrl = (options.baseUrl ?? "https://api.openai.com/v1").replace(/\/+$/, "")
  const fetchImpl = options.fetch ?? fetch
  const name = `openai-chat:${options.model}`

  return {
    name,
    async complete(request: ModelRequest): Promise<ModelResponse> {
      const body = {
        model: options.model,
        messages: toOpenAIMessages(request),
        ...(request.tools.length > 0
          ? {
              tools: request.tools.map((tool) => ({
                type: "function",
                function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
              })),
            }
          : {}),
        ...options.extraBody,
      }
      const headers: Record<string, string> = { ...options.headers }
      if (options.apiKey) headers.authorization = `Bearer ${options.apiKey}`

      const json = (await postJson(fetchImpl, name, `${baseUrl}/chat/completions`, headers, body, request.signal).catch((error: unknown) => {
        if (error instanceof ModelHttpError && error.status === 400 && /set reasoning_effort to ["']none["']/i.test(error.body)) {
          error.message += `\nTry --model-options '{"reasoning_effort":"none"}' (or OWA_MODEL_OPTIONS) if supported by this endpoint. No model options are changed automatically.`
        }
        throw error
      })) as {
        model?: string
        choices?: Array<{ message?: { content?: string | null; tool_calls?: OpenAIToolCall[] }; finish_reason?: string }>
        usage?: {
          prompt_tokens?: number
          completion_tokens?: number
          prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number } | null
          cost?: number
        }
      }
      const message = json.choices?.[0]?.message
      if (!message) throw new Error(`${name} returned no choices`)

      return {
        text: message.content ?? undefined,
        finishReason: json.choices?.[0]?.finish_reason,
        toolCalls: (message.tool_calls ?? []).map((call) => ({
          id: call.id,
          name: call.function.name,
          arguments: parseToolArguments(call.function.arguments),
        })),
        model: json.model || undefined,
        // prompt_tokens already includes cache reads and writes. OpenRouter adds cache_write_tokens and cost.
        usage: reportedUsage({
          inputTokens: json.usage?.prompt_tokens,
          outputTokens: json.usage?.completion_tokens,
          cachedInputTokens: json.usage?.prompt_tokens_details?.cached_tokens,
          cacheWriteTokens: json.usage?.prompt_tokens_details?.cache_write_tokens,
          cost: json.usage?.cost,
        }),
      }
    },
  }
}

interface OpenAIToolCall {
  id: string
  function: { name: string; arguments: string }
}

function toOpenAIMessages(request: ModelRequest): unknown[] {
  const out: unknown[] = [{ role: "system", content: request.system }]
  // Chat Completions tool messages are text-only, so images from tool results
  // are re-sent as a user message right after the tool message batch.
  let pendingImages: ContentPart[] = []
  const flushImages = () => {
    if (pendingImages.length === 0) return
    out.push({ role: "user", content: [{ type: "text", text: "Images returned by the tools above:" }, ...pendingImages.map(toPart)] })
    pendingImages = []
  }

  for (const message of request.messages) {
    if (message.role !== "tool") flushImages()
    out.push(...convert(message, (image) => pendingImages.push(image)))
  }
  flushImages()
  return out
}

function convert(message: Message, deferImage: (image: ContentPart) => void): unknown[] {
  switch (message.role) {
    case "user":
      return [{ role: "user", content: message.content.map(toPart) }]
    case "assistant":
      return [
        {
          role: "assistant",
          content: message.text ?? null,
          ...(message.toolCalls.length > 0
            ? {
                tool_calls: message.toolCalls.map((call) => ({
                  id: call.id,
                  type: "function",
                  function: { name: call.name, arguments: JSON.stringify(call.arguments) },
                })),
              }
            : {}),
        },
      ]
    case "tool": {
      const text = message.content
        .filter((part): part is Extract<ContentPart, { type: "text" }> => part.type === "text")
        .map((part) => part.text)
        .join("\n")
      for (const part of message.content) if (part.type === "image") deferImage(part)
      return [{ role: "tool", tool_call_id: message.toolCallId, content: text || "(no text output)" }]
    }
  }
}

function toPart(part: ContentPart): unknown {
  return part.type === "text"
    ? { type: "text", text: part.text }
    : { type: "image_url", image_url: { url: `data:${part.mimeType};base64,${part.data}` } }
}

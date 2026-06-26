import type { ModelMessage, ModelRequest, ModelResponse } from "@open-web-agent/core"
import type { FetchLike } from "./openai-compatible-client"
import { isTransientModelProviderError, ModelProviderHttpError, retryModelCall } from "./retry"
import { shouldRetryWithoutTemperature, withoutTemperatureParameter } from "./temperature-fallback"

export interface OpenAIResponsesClientOptions {
  baseUrl: string
  accessToken: string | null
  fetch?: FetchLike
  defaultHeaders?: Record<string, string>
  maxRetry?: number
}

export interface ResponsesClientCompleteOptions {
  signal?: AbortSignal
}

interface ResponsesApiResponse {
  id?: string | null
  output_text?: string | null
  output?: unknown
  usage?: {
    input_tokens?: number | null
    output_tokens?: number | null
    total_tokens?: number | null
  } | null
}

export class OpenAIResponsesClient {
  private readonly fetchImpl: FetchLike

  constructor(private readonly options: OpenAIResponsesClientOptions) {
    this.fetchImpl = options.fetch ?? fetch
  }

  async complete(request: ModelRequest, options: ResponsesClientCompleteOptions = {}): Promise<ModelResponse> {
    const startedAt = performance.now()
    let requestForAttempt = request
    const raw = await retryModelCall(async () => {
      throwIfAborted(options.signal)
      try {
        return await this.fetchResponse(requestForAttempt, options.signal)
      } catch (error) {
        throwIfAborted(options.signal)
        if (shouldRetryWithoutTemperature(requestForAttempt, error)) {
          requestForAttempt = withoutTemperatureParameter(requestForAttempt)
          throwIfAborted(options.signal)
          return await this.fetchResponse(requestForAttempt, options.signal)
        }
        throw error
      }
    }, { maxRetry: this.options.maxRetry, isRetryable: (error) => !options.signal?.aborted && isTransientModelProviderError(error) })
    const usage = raw.usage

    return {
      id: raw.id ?? null,
      text: readResponseText(raw),
      toolCalls: [],
      raw,
      usage: usage
        ? {
            inputTokens: usage.input_tokens ?? null,
            outputTokens: usage.output_tokens ?? null,
            totalTokens: usage.total_tokens ?? null,
          }
        : null,
      latencyMs: performance.now() - startedAt,
    }
  }

  private headers(): Record<string, string> {
    return {
      "content-type": "application/json",
      ...(this.options.accessToken ? { authorization: `Bearer ${this.options.accessToken}` } : {}),
      ...(this.options.defaultHeaders ?? {}),
    }
  }

  private async fetchResponse(request: ModelRequest, signal: AbortSignal | undefined): Promise<ResponsesApiResponse> {
    const response = await this.fetchImpl(`${trimTrailingSlash(this.options.baseUrl)}/responses`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(toResponsesBody(request)),
      signal,
    })

    if (!response.ok) {
      throw new ModelProviderHttpError(response.status, await response.text())
    }

    return (await response.json()) as ResponsesApiResponse
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw signal.reason ?? new DOMException("Model call cancelled", "AbortError")
  }
}

function toResponsesBody(request: ModelRequest): Record<string, unknown> {
  const instructions = request.messages.filter((message) => message.role === "system").map((message) => message.content)
  const input = request.messages.filter((message) => message.role !== "system").map(toResponsesInputMessage)

  return {
    ...(request.extraBody ?? {}),
    model: request.model,
    input,
    ...(instructions.length > 0 ? { instructions: instructions.map(formatContent).join("\n\n") } : {}),
    ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
    ...(request.topP !== undefined ? { top_p: request.topP } : {}),
    ...(request.maxTokens !== undefined ? { max_output_tokens: request.maxTokens } : {}),
    ...(request.presencePenalty !== undefined ? { presence_penalty: request.presencePenalty } : {}),
    ...(request.frequencyPenalty !== undefined ? { frequency_penalty: request.frequencyPenalty } : {}),
    ...(request.seed !== undefined ? { seed: request.seed } : {}),
    ...(request.stop !== undefined ? { stop: request.stop } : {}),
    ...(request.responseFormat === "json" ? { text: { format: { type: "json_object" } } } : {}),
  }
}

function toResponsesInputMessage(message: ModelMessage): Record<string, unknown> {
  return {
    role: message.role,
    content: message.content,
  }
}

function formatContent(content: ModelMessage["content"]): string {
  if (typeof content === "string") return content
  return content.map((part) => (typeof part.text === "string" ? part.text : JSON.stringify(part))).join("\n")
}

function readResponseText(raw: ResponsesApiResponse): string {
  if (typeof raw.output_text === "string") return raw.output_text

  const output = Array.isArray(raw.output) ? raw.output : []
  const text: string[] = []
  for (const item of output) {
    if (!isRecord(item) || !Array.isArray(item.content)) continue
    for (const content of item.content) {
      if (!isRecord(content)) continue
      if (typeof content.text === "string") text.push(content.text)
    }
  }
  return text.join("")
}

function trimTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

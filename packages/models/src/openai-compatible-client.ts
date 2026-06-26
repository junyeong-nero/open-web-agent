import type { ModelRequest, ModelResponse } from "@open-web-agent/core"
import { isTransientModelProviderError, ModelProviderHttpError, retryModelCall } from "./retry"
import { shouldRetryWithoutTemperature, withoutTemperatureParameter } from "./temperature-fallback"

export type FetchLike = (url: RequestInfo | URL, init?: RequestInit) => Promise<Response>

export interface OpenAICompatibleClientOptions {
  baseUrl: string
  apiKey: string | null
  fetch?: FetchLike
  defaultHeaders?: Record<string, string>
  maxRetry?: number
}

export interface ModelClientCompleteOptions {
  signal?: AbortSignal
}

interface ChatCompletionResponse {
  id?: string | null
  choices?: Array<{ message?: { content?: string | null } }>
  usage?: {
    prompt_tokens?: number | null
    completion_tokens?: number | null
    total_tokens?: number | null
  } | null
}

export class OpenAICompatibleClient {
  private readonly fetchImpl: FetchLike

  constructor(private readonly options: OpenAICompatibleClientOptions) {
    this.fetchImpl = options.fetch ?? fetch
  }

  async complete(request: ModelRequest, options: ModelClientCompleteOptions = {}): Promise<ModelResponse> {
    const startedAt = performance.now()
    let requestForAttempt = request
    const raw = await retryModelCall(async () => {
      throwIfAborted(options.signal)
      try {
        return await this.fetchCompletion(requestForAttempt, options.signal)
      } catch (error) {
        throwIfAborted(options.signal)
        if (shouldRetryWithoutTemperature(requestForAttempt, error)) {
          requestForAttempt = withoutTemperatureParameter(requestForAttempt)
          throwIfAborted(options.signal)
          return await this.fetchCompletion(requestForAttempt, options.signal)
        }
        throw error
      }
    }, { maxRetry: this.options.maxRetry, isRetryable: (error) => !options.signal?.aborted && isTransientModelProviderError(error) })
    const usage = raw.usage

    return {
      id: raw.id ?? null,
      text: raw.choices?.[0]?.message?.content ?? "",
      toolCalls: [],
      raw,
      usage: usage
        ? {
            inputTokens: usage.prompt_tokens ?? null,
            outputTokens: usage.completion_tokens ?? null,
            totalTokens: usage.total_tokens ?? null,
          }
        : null,
      latencyMs: performance.now() - startedAt,
    }
  }

  private headers(): Record<string, string> {
    return {
      "content-type": "application/json",
      ...(this.options.apiKey ? { authorization: `Bearer ${this.options.apiKey}` } : {}),
      ...(this.options.defaultHeaders ?? {}),
    }
  }

  private async fetchCompletion(request: ModelRequest, signal: AbortSignal | undefined): Promise<ChatCompletionResponse> {
    const response = await this.fetchImpl(`${trimTrailingSlash(this.options.baseUrl)}/chat/completions`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(toChatCompletionsBody(request)),
      signal,
    })

    if (!response.ok) {
      throw new ModelProviderHttpError(response.status, await response.text())
    }

    return (await response.json()) as ChatCompletionResponse
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw signal.reason ?? new DOMException("Model call cancelled", "AbortError")
  }
}

function toChatCompletionsBody(request: ModelRequest): Record<string, unknown> {
  return {
    ...(request.extraBody ?? {}),
    model: request.model,
    messages: request.messages,
    ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
    ...(request.topP !== undefined ? { top_p: request.topP } : {}),
    ...(request.maxTokens !== undefined ? { max_tokens: request.maxTokens } : {}),
    ...(request.presencePenalty !== undefined ? { presence_penalty: request.presencePenalty } : {}),
    ...(request.frequencyPenalty !== undefined ? { frequency_penalty: request.frequencyPenalty } : {}),
    ...(request.seed !== undefined ? { seed: request.seed } : {}),
    ...(request.stop !== undefined ? { stop: request.stop } : {}),
    ...(request.responseFormat === "json" ? { response_format: { type: "json_object" } } : {}),
  }
}

function trimTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value
}

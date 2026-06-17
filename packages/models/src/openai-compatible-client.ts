import type { ModelRequest, ModelResponse } from "@open-web-agent/core"

export type FetchLike = (url: RequestInfo | URL, init?: RequestInit) => Promise<Response>

export interface OpenAICompatibleClientOptions {
  baseUrl: string
  apiKey: string | null
  fetch?: FetchLike
  defaultHeaders?: Record<string, string>
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

  async complete(request: ModelRequest): Promise<ModelResponse> {
    const startedAt = performance.now()
    const response = await this.fetchImpl(`${trimTrailingSlash(this.options.baseUrl)}/chat/completions`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(toChatCompletionsBody(request)),
    })

    if (!response.ok) {
      throw new Error(`Model provider returned HTTP ${response.status}: ${await response.text()}`)
    }

    const raw = (await response.json()) as ChatCompletionResponse
    const usage = raw.usage

    return {
      id: raw.id ?? null,
      text: raw.choices?.[0]?.message?.content ?? "",
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
}

function toChatCompletionsBody(request: ModelRequest): Record<string, unknown> {
  return {
    ...(request.extraBody ?? {}),
    model: request.model,
    messages: request.messages,
    temperature: request.temperature,
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

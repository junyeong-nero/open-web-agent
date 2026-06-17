import type { ModelPlugin, ModelRequest, ModelResponse, RuntimeContext } from "@open-web-agent/core"
import { OpenAICompatibleClient, type FetchLike } from "./openai-compatible-client"
import { readModelConfig } from "./model-config"

export interface OpenRouterModelOptions {
  apiKey?: string | null
  defaultModel?: string
  reasoningEffort?: string
  contextWindowTokens?: number
  fetch?: FetchLike
}

export class OpenRouterModel implements ModelPlugin {
  id = "openrouter"
  name = "OpenRouter"
  provider = "openrouter"
  readonly modelName: string
  readonly reasoningEffort: string
  readonly contextWindowTokens: number
  private readonly defaultModel: string
  private readonly client: OpenAICompatibleClient

  constructor(options: OpenRouterModelOptions = {}) {
    const config = readModelConfig()
    this.defaultModel = options.defaultModel ?? config.defaultModel
    this.modelName = this.defaultModel
    this.reasoningEffort = options.reasoningEffort ?? config.reasoningEffort
    this.contextWindowTokens = options.contextWindowTokens ?? config.contextWindowTokens
    this.client = new OpenAICompatibleClient({
      baseUrl: "https://openrouter.ai/api/v1",
      apiKey: options.apiKey ?? config.openrouterApiKey,
      fetch: options.fetch,
      defaultHeaders: {
        "http-referer": "https://github.com/open-web-agent/open-web-agent",
        "x-title": "Open Web Agent",
      },
    })
  }

  async complete(request: ModelRequest, _ctx: RuntimeContext): Promise<ModelResponse> {
    return this.client.complete({ ...request, model: request.model || this.defaultModel })
  }
}

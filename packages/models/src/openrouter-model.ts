import type { ModelPlugin, ModelRequest, ModelResponse, RuntimeContext } from "@open-web-agent/core"
import { OpenAICompatibleClient, type FetchLike } from "./openai-compatible-client"
import { readModelConfig, type ModelParameters } from "./model-config"

export interface OpenRouterModelOptions {
  apiKey?: string | null
  defaultModel?: string
  defaultParameters?: ModelParameters
  fetch?: FetchLike
}

export class OpenRouterModel implements ModelPlugin {
  id = "openrouter"
  name = "OpenRouter"
  provider = "openrouter"
  private readonly defaultModel: string
  private readonly defaultParameters: ModelParameters
  private readonly client: OpenAICompatibleClient

  constructor(options: OpenRouterModelOptions = {}) {
    const config = readModelConfig()
    this.defaultModel = options.defaultModel ?? config.defaultModel
    this.defaultParameters = options.defaultParameters ?? config.parameters
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
    return this.client.complete({ ...request, ...this.defaultParameters, model: request.model || this.defaultModel })
  }
}

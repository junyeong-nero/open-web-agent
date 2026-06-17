import type { ModelPlugin, ModelRequest, ModelResponse, RuntimeContext } from "@open-web-agent/core"
import { OpenAICompatibleClient, type FetchLike } from "./openai-compatible-client"
import { readModelConfig } from "./model-config"

export interface OpenAIModelOptions {
  apiKey?: string | null
  defaultModel?: string
  fetch?: FetchLike
}

export class OpenAIModel implements ModelPlugin {
  id = "openai"
  name = "OpenAI"
  provider = "openai"
  private readonly defaultModel: string
  private readonly client: OpenAICompatibleClient

  constructor(options: OpenAIModelOptions = {}) {
    const config = readModelConfig()
    this.defaultModel = options.defaultModel ?? config.defaultModel
    this.client = new OpenAICompatibleClient({
      baseUrl: "https://api.openai.com/v1",
      apiKey: options.apiKey ?? config.openaiApiKey,
      fetch: options.fetch,
    })
  }

  async complete(request: ModelRequest, _ctx: RuntimeContext): Promise<ModelResponse> {
    return this.client.complete({ ...request, model: request.model || this.defaultModel })
  }
}

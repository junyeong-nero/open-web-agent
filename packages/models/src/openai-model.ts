import type { ModelPlugin, ModelRequest, ModelResponse, RuntimeContext } from "@open-web-agent/core"
import { OpenAICompatibleClient, type FetchLike } from "./openai-compatible-client"
import { readModelConfig, resolveProviderDefaultModel, type ModelParameters } from "./model-config"

export interface OpenAIModelOptions {
  apiKey?: string | null
  defaultModel?: string
  defaultParameters?: ModelParameters
  reasoningEffort?: string
  contextWindowTokens?: number
  fetch?: FetchLike
}

export class OpenAIModel implements ModelPlugin {
  id = "openai"
  name = "OpenAI"
  provider = "openai"
  readonly modelName: string
  readonly reasoningEffort: string
  readonly contextWindowTokens: number
  private readonly defaultModel: string
  private readonly defaultParameters: ModelParameters
  private readonly client: OpenAICompatibleClient

  constructor(options: OpenAIModelOptions = {}) {
    const config = readModelConfig()
    this.defaultModel = options.defaultModel ?? resolveProviderDefaultModel("openai", config.defaultModel)
    this.defaultParameters = options.defaultParameters ?? config.parameters
    this.modelName = this.defaultModel
    this.reasoningEffort = options.reasoningEffort ?? config.reasoningEffort
    this.contextWindowTokens = options.contextWindowTokens ?? config.contextWindowTokens
    this.client = new OpenAICompatibleClient({
      baseUrl: "https://api.openai.com/v1",
      apiKey: options.apiKey ?? config.openaiApiKey,
      fetch: options.fetch,
    })
  }

  async complete(request: ModelRequest, _ctx: RuntimeContext): Promise<ModelResponse> {
    return this.client.complete({ ...request, ...this.defaultParameters, model: request.model || this.defaultModel })
  }
}

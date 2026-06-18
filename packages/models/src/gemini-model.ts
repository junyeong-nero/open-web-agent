import type { ModelPlugin, ModelRequest, ModelResponse, RuntimeContext } from "@open-web-agent/core"
import { OpenAICompatibleClient, type FetchLike } from "./openai-compatible-client"
import { readModelConfig, resolveProviderDefaultModel, type ModelParameters } from "./model-config"

export interface GeminiModelOptions {
  apiKey?: string | null
  defaultModel?: string
  defaultParameters?: ModelParameters
  reasoningEffort?: string
  contextWindowTokens?: number
  maxRetry?: number
  fetch?: FetchLike
}

export class GeminiModel implements ModelPlugin {
  id = "gemini"
  name = "Gemini"
  provider = "gemini"
  readonly modelName: string
  readonly contextWindowTokens: number
  private readonly defaultModel: string
  private readonly defaultParameters: ModelParameters
  private readonly client: OpenAICompatibleClient

  constructor(options: GeminiModelOptions = {}) {
    const config = readModelConfig()
    this.defaultModel = options.defaultModel ?? resolveProviderDefaultModel("gemini", config.defaultModel)
    this.defaultParameters = options.defaultParameters ?? config.parameters
    this.modelName = this.defaultModel
    this.contextWindowTokens = options.contextWindowTokens ?? config.contextWindowTokens
    this.client = new OpenAICompatibleClient({
      baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
      apiKey: options.apiKey ?? config.geminiApiKey,
      fetch: options.fetch,
      maxRetry: options.maxRetry ?? config.maxRetry,
    })
  }

  async complete(request: ModelRequest, _ctx: RuntimeContext): Promise<ModelResponse> {
    return this.client.complete({ ...request, ...this.defaultParameters, model: request.model || this.defaultModel })
  }
}

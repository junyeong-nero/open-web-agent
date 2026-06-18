import type { ModelPlugin, ModelRequest, ModelResponse, RuntimeContext } from "@open-web-agent/core"
import { OpenAICompatibleClient, type FetchLike } from "./openai-compatible-client"
import { readModelConfig, resolveProviderDefaultModel, type ModelParameters } from "./model-config"

export interface OpenAIModelOptions {
  id?: string
  name?: string
  apiKey?: string | null
  defaultModel?: string
  defaultParameters?: ModelParameters
  reasoningEffort?: string
  contextWindowTokens?: number
  maxRetry?: number
  forceDefaultModel?: boolean
  fetch?: FetchLike
}

export class OpenAIModel implements ModelPlugin {
  readonly id: string
  readonly name: string
  provider = "openai"
  readonly modelName: string
  readonly reasoningEffort: string
  readonly contextWindowTokens: number
  private readonly defaultModel: string
  private readonly defaultParameters: ModelParameters
  private readonly forceDefaultModel: boolean
  private readonly client: OpenAICompatibleClient

  constructor(options: OpenAIModelOptions = {}) {
    const config = readModelConfig()
    this.id = options.id ?? "openai"
    this.name = options.name ?? "OpenAI"
    this.defaultModel = options.defaultModel ?? resolveProviderDefaultModel("openai", config.defaultModel)
    this.defaultParameters = options.defaultParameters ?? config.parameters
    this.modelName = this.defaultModel
    this.reasoningEffort = options.reasoningEffort ?? config.reasoningEffort
    this.contextWindowTokens = options.contextWindowTokens ?? config.contextWindowTokens
    this.forceDefaultModel = options.forceDefaultModel ?? false
    this.client = new OpenAICompatibleClient({
      baseUrl: "https://api.openai.com/v1",
      apiKey: options.apiKey ?? config.openaiApiKey,
      fetch: options.fetch,
      maxRetry: options.maxRetry ?? config.maxRetry,
    })
  }

  async complete(request: ModelRequest, _ctx: RuntimeContext): Promise<ModelResponse> {
    const model = this.forceDefaultModel ? this.defaultModel : request.model || this.defaultModel
    return this.client.complete({ ...request, ...this.defaultParameters, model })
  }
}

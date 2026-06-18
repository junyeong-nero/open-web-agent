import type { ModelPlugin, ModelRequest, ModelResponse, RuntimeContext } from "@open-web-agent/core"
import { OpenAICompatibleClient, type FetchLike } from "./openai-compatible-client"
import { readModelConfig, resolveProviderDefaultModel, type ModelParameters } from "./model-config"
import { withChatReasoningEffort } from "./reasoning-effort"

export interface OpenRouterModelOptions {
  id?: string
  name?: string
  apiKey?: string | null
  defaultModel?: string
  defaultParameters?: ModelParameters
  reasoningEffort?: string
  contextWindowTokens?: number
  forceDefaultModel?: boolean
  fetch?: FetchLike
}

export class OpenRouterModel implements ModelPlugin {
  readonly id: string
  readonly name: string
  provider = "openrouter"
  readonly modelName: string
  readonly reasoningEffort: string
  readonly contextWindowTokens: number
  private readonly defaultModel: string
  private readonly defaultParameters: ModelParameters
  private readonly forceDefaultModel: boolean
  private readonly client: OpenAICompatibleClient

  constructor(options: OpenRouterModelOptions = {}) {
    const config = readModelConfig()
    this.id = options.id ?? "openrouter"
    this.name = options.name ?? "OpenRouter"
    this.defaultModel = options.defaultModel ?? resolveProviderDefaultModel("openrouter", config.defaultModel)
    this.defaultParameters = options.defaultParameters ?? config.parameters
    this.modelName = this.defaultModel
    this.reasoningEffort = options.reasoningEffort ?? config.reasoningEffort
    this.contextWindowTokens = options.contextWindowTokens ?? config.contextWindowTokens
    this.forceDefaultModel = options.forceDefaultModel ?? false
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
    const model = this.forceDefaultModel ? this.defaultModel : request.model || this.defaultModel
    return this.client.complete(withChatReasoningEffort({ ...request, ...this.defaultParameters, model }, this.reasoningEffort))
  }
}

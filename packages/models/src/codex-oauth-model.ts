import type { ModelPlugin, ModelRequest, ModelResponse, RuntimeContext } from "@open-web-agent/core"
import { readCodexOAuthToken } from "./codex-auth"
import { readModelConfig, type ModelParameters } from "./model-config"
import { OpenAIResponsesClient } from "./openai-responses-client"
import type { FetchLike } from "./openai-compatible-client"
import { withResponsesReasoningEffort } from "./reasoning-effort"

export interface CodexOAuthModelOptions {
  accessToken?: string | null
  defaultModel?: string
  defaultParameters?: ModelParameters
  reasoningEffort?: string
  contextWindowTokens?: number
  maxRetry?: number
  fetch?: FetchLike
}

export class CodexOAuthModel implements ModelPlugin {
  id = "codex-oauth"
  name = "Codex OAuth"
  provider = "codex-oauth"
  readonly modelName: string
  readonly reasoningEffort: string
  readonly contextWindowTokens: number
  private readonly defaultModel: string
  private readonly defaultParameters: ModelParameters
  private readonly client: OpenAIResponsesClient

  constructor(options: CodexOAuthModelOptions = {}) {
    const config = readModelConfig()
    this.defaultModel = options.defaultModel ?? config.defaultModel
    this.defaultParameters = options.defaultParameters ?? config.parameters
    this.modelName = this.defaultModel
    this.reasoningEffort = options.reasoningEffort ?? config.reasoningEffort
    this.contextWindowTokens = options.contextWindowTokens ?? config.contextWindowTokens
    this.client = new OpenAIResponsesClient({
      baseUrl: "https://api.openai.com/v1",
      accessToken: options.accessToken ?? readCodexOAuthToken(),
      fetch: options.fetch,
      maxRetry: options.maxRetry ?? config.maxRetry,
    })
  }

  async complete(request: ModelRequest, _ctx: RuntimeContext): Promise<ModelResponse> {
    return this.client.complete(
      withResponsesReasoningEffort({ ...request, ...this.defaultParameters, model: request.model || this.defaultModel }, this.reasoningEffort),
    )
  }
}

import { MockAgent, PlanActAgent, SeeActAgent, SimpleReActAgent } from "@open-web-agent/agents"
import { MockEnvironment, PlaywrightEnvironment } from "@open-web-agent/browser"
import {
  EventBus,
  PluginRegistry,
  resolveOwaHome,
  RunOrchestrator,
  type ModelPlugin,
  type ModelRequest,
  type ModelResponse,
  type RuntimeContext,
  type SessionState,
} from "@open-web-agent/core"
import { OpenAIModel, OpenRouterModel, readModelConfig } from "@open-web-agent/models"
import { SQLiteStore } from "@open-web-agent/storage"
import { join } from "node:path"
import { createApp } from "./app"
import { startServer, type StartedServer } from "./start-server"

export interface StartDefaultRuntimeOptions {
  home?: string
  hostname?: string
  port?: number
  environmentDelayMs?: number
  env?: NodeJS.ProcessEnv
  configPath?: string
}

export interface StartedDefaultRuntime {
  url: string
  eventBus: EventBus
  registry: PluginRegistry
  sessions: Map<string, SessionState>
  storage: SQLiteStore
  server: StartedServer
  stop(): Promise<void>
}

export async function startDefaultRuntime(options: StartDefaultRuntimeOptions = {}): Promise<StartedDefaultRuntime> {
  const home = options.home ?? resolveOwaHome()
  const eventBus = new EventBus()
  const registry = new PluginRegistry()
  const modelConfig = readModelConfig(options.env ?? process.env, { configPath: options.configPath })

  registry.registerAgent(new MockAgent())
  if (modelConfig.openaiApiKey) {
    registry.registerModel(
      new OpenAIModel({
        apiKey: modelConfig.openaiApiKey,
        defaultModel: modelConfig.defaultModel,
        defaultParameters: modelConfig.parameters,
        reasoningEffort: modelConfig.reasoningEffort,
        contextWindowTokens: modelConfig.contextWindowTokens,
      }),
    )
  }
  if (modelConfig.openrouterApiKey) {
    registry.registerModel(
      new OpenRouterModel({
        apiKey: modelConfig.openrouterApiKey,
        defaultModel: modelConfig.defaultModel,
        defaultParameters: modelConfig.parameters,
        reasoningEffort: modelConfig.reasoningEffort,
        contextWindowTokens: modelConfig.contextWindowTokens,
      }),
    )
  }

  const defaultModelId = registry.listModels()[0]?.id
  const selectedModel = new RuntimeSelectedModel(registry, defaultModelId)
  registry.registerAgent(new SimpleReActAgent({ model: selectedModel, modelName: modelConfig.defaultModel }))
  registry.registerAgent(new SeeActAgent({ model: selectedModel, modelName: modelConfig.defaultModel }))
  registry.registerAgent(new PlanActAgent({ model: selectedModel, modelName: modelConfig.defaultModel }))

  registry.registerEnvironment(new MockEnvironment(options.environmentDelayMs))
  registry.registerEnvironment(new PlaywrightEnvironment())

  const sessions = new Map<string, SessionState>()
  const orchestrator = new RunOrchestrator({
    home,
    eventBus,
    registry,
    agentId: "mock-agent",
    modelId: defaultModelId,
    environmentId: "mock-browser",
    maxSteps: 4,
  })
  const storage = new SQLiteStore(join(home, "metadata.sqlite"))
  storage.migrate()
  const app = createApp({ eventBus, orchestrator, registry, sessions, storage })
  const server = await startServer({
    app,
    hostname: options.hostname,
    port: options.port,
  })

  return {
    url: server.url,
    eventBus,
    registry,
    sessions,
    storage,
    server,
    stop: async () => {
      await server.stop()
      storage.close()
    },
  }
}

class RuntimeSelectedModel implements ModelPlugin {
  id = "runtime-selected-model"
  name = "Runtime Selected Model"
  provider = "runtime"

  constructor(
    private readonly registry: PluginRegistry,
    private readonly defaultModelId: string | undefined,
  ) {}

  async complete(request: ModelRequest, ctx: RuntimeContext): Promise<ModelResponse> {
    const modelId = ctx.modelId ?? this.defaultModelId
    if (!modelId) {
      throw new Error("No model selected. Configure OPENAI_API_KEY or OPENROUTER_API_KEY, then use /model <id>.")
    }

    const model = this.registry.getModel(modelId)
    const metadata = {
      modelId,
      modelName: model.modelName ?? request.model,
      provider: model.provider,
      reasoningEffort: model.reasoningEffort ?? null,
      contextWindowTokens: model.contextWindowTokens ?? null,
    }

    await ctx.emit("model.called", metadata)
    const response = await model.complete(request, ctx)
    await ctx.emit("model.completed", {
      ...metadata,
      response: {
        id: response.id,
        usage: response.usage,
        latencyMs: response.latencyMs,
      },
    })
    return response
  }
}

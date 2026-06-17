import { loadPythonAgentManifests, MockAgent, PlanActAgent, SeeActAgent, SimpleReActAgent } from "@open-web-agent/agents"
import {
  MockBrowserToolAdapter,
  MockEnvironment,
  PlaywrightBrowserToolAdapter,
  PlaywrightEnvironment,
} from "@open-web-agent/browser"
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
import {
  createOpenAIModelPool,
  createOpenRouterModelPool,
  OpenAIModel,
  OpenRouterModel,
  readModelConfig,
} from "@open-web-agent/models"
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
  agentsDir?: string
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
  const modelCallTimeoutMs = readModelCallTimeoutMs(options.env ?? process.env)

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
    for (const model of createOpenAIModelPool({
      apiKey: modelConfig.openaiApiKey,
      defaultParameters: modelConfig.parameters,
      reasoningEffort: modelConfig.reasoningEffort,
    })) {
      registry.registerModel(model)
    }
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
    for (const model of createOpenRouterModelPool({
      apiKey: modelConfig.openrouterApiKey,
      defaultParameters: modelConfig.parameters,
      reasoningEffort: modelConfig.reasoningEffort,
    })) {
      registry.registerModel(model)
    }
  }

  const defaultModelId = registry.listModels()[0]?.id
  const selectedModel = new RuntimeSelectedModel(registry, defaultModelId)
  const modelBackedAgentOptions = {
    model: selectedModel,
    modelName: modelConfig.defaultModel,
    timeoutMs: modelCallTimeoutMs,
  }
  registry.registerAgent(new SimpleReActAgent(modelBackedAgentOptions))
  registry.registerAgent(new SeeActAgent(modelBackedAgentOptions))
  registry.registerAgent(new PlanActAgent(modelBackedAgentOptions))
  for (const agent of await loadPythonAgentManifests(options.agentsDir ?? join(home, "agents"), { model: selectedModel })) {
    registry.registerAgent(agent)
  }

  const mockEnvironment = new MockEnvironment(options.environmentDelayMs)
  const playwrightEnvironment = new PlaywrightEnvironment()
  registry.registerEnvironment(mockEnvironment)
  registry.registerToolAdapter(new MockBrowserToolAdapter(mockEnvironment))
  registry.registerEnvironment(playwrightEnvironment)
  registry.registerToolAdapter(new PlaywrightBrowserToolAdapter(playwrightEnvironment))

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

function readModelCallTimeoutMs(env: NodeJS.ProcessEnv): number | undefined {
  const value = env.OPEN_WEB_AGENT_MODEL_TIMEOUT_MS
  if (!value) return undefined

  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error("Invalid OPEN_WEB_AGENT_MODEL_TIMEOUT_MS: must be a positive integer")
  }
  return parsed
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

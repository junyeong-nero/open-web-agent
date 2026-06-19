import { loadPythonAgentManifests, PlanActAgent, SeeActAgent, SimpleReActAgent } from "@open-web-agent/agents"
import { PlaywrightBrowserToolAdapter, PlaywrightEnvironment } from "@open-web-agent/browser"
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
  ClaudeModel,
  CodexOAuthModel,
  createOpenAIModelPool,
  createOpenRouterModelPool,
  GeminiModel,
  OpenAIModel,
  OpenRouterModel,
  readCodexOAuthToken,
  readModelConfig,
  resolveProviderDefaultModel,
} from "@open-web-agent/models"
import { SQLiteStore } from "@open-web-agent/storage"
import { join } from "node:path"
import { createApp } from "./app"
import { BrowserSessionManager } from "./browser-session-manager"
import { startServer, type StartedServer } from "./start-server"

export interface StartDefaultRuntimeOptions {
  home?: string
  hostname?: string
  port?: number
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
  const env = options.env ?? process.env
  const modelConfig = readModelConfig(env, { configPath: options.configPath })
  const modelCallTimeoutMs = readModelCallTimeoutMs(env)

  const models: ModelPlugin[] = []

  if (modelConfig.openrouterApiKey) {
    models.push(
      new OpenRouterModel({
        apiKey: modelConfig.openrouterApiKey,
        defaultModel: resolveProviderDefaultModel("openrouter", modelConfig.defaultModel, modelConfig.defaultModelProvider),
        defaultParameters: modelConfig.parameters,
        reasoningEffort: modelConfig.reasoningEffort,
        contextWindowTokens: modelConfig.contextWindowTokens,
        maxRetry: modelConfig.maxRetry,
      }),
      ...createOpenRouterModelPool({
        apiKey: modelConfig.openrouterApiKey,
        defaultParameters: modelConfig.parameters,
        reasoningEffort: modelConfig.reasoningEffort,
        maxRetry: modelConfig.maxRetry,
      }),
    )
  }
  if (modelConfig.openaiApiKey) {
    models.push(
      new OpenAIModel({
        apiKey: modelConfig.openaiApiKey,
        defaultModel: resolveProviderDefaultModel("openai", modelConfig.defaultModel, modelConfig.defaultModelProvider),
        defaultParameters: modelConfig.parameters,
        reasoningEffort: modelConfig.reasoningEffort,
        contextWindowTokens: modelConfig.contextWindowTokens,
        maxRetry: modelConfig.maxRetry,
      }),
      ...createOpenAIModelPool({
        apiKey: modelConfig.openaiApiKey,
        defaultParameters: modelConfig.parameters,
        reasoningEffort: modelConfig.reasoningEffort,
        maxRetry: modelConfig.maxRetry,
      }),
    )
  }
  if (modelConfig.geminiApiKey) {
    models.push(
      new GeminiModel({
        apiKey: modelConfig.geminiApiKey,
        defaultModel: resolveProviderDefaultModel("gemini", modelConfig.defaultModel, modelConfig.defaultModelProvider),
        defaultParameters: modelConfig.parameters,
        reasoningEffort: modelConfig.reasoningEffort,
        contextWindowTokens: modelConfig.contextWindowTokens,
        maxRetry: modelConfig.maxRetry,
      }),
    )
  }
  if (modelConfig.anthropicApiKey) {
    models.push(
      new ClaudeModel({
        apiKey: modelConfig.anthropicApiKey,
        defaultModel: resolveProviderDefaultModel("claude", modelConfig.defaultModel, modelConfig.defaultModelProvider),
        defaultParameters: modelConfig.parameters,
        reasoningEffort: modelConfig.reasoningEffort,
        contextWindowTokens: modelConfig.contextWindowTokens,
        maxRetry: modelConfig.maxRetry,
      }),
    )
  }

  const codexOAuthToken = readCodexOAuthToken(env, { authPath: modelConfig.codexAuthPath })
  if (codexOAuthToken) {
    models.push(
      new CodexOAuthModel({
        accessToken: codexOAuthToken,
        defaultModel: modelConfig.defaultModel,
        defaultParameters: modelConfig.parameters,
        reasoningEffort: modelConfig.reasoningEffort,
        contextWindowTokens: modelConfig.contextWindowTokens,
        maxRetry: modelConfig.maxRetry,
      }),
    )
  }

  for (const model of orderModels(models, modelConfig.defaultModelProvider)) {
    registry.registerModel(model)
  }

  const defaultModelId = registry.listModels()[0]?.id
  const defaultRuntimeModel = defaultModelId ? registry.getModel(defaultModelId) : undefined
  const selectedModel = new RuntimeSelectedModel(registry, defaultModelId)
  const modelBackedAgentOptions = {
    model: selectedModel,
    modelName: defaultRuntimeModel?.modelName ?? modelConfig.defaultModel,
    timeoutMs: modelCallTimeoutMs,
  }
  registry.registerAgent(new SimpleReActAgent(modelBackedAgentOptions))
  registry.registerAgent(new SeeActAgent(modelBackedAgentOptions))
  registry.registerAgent(new PlanActAgent(modelBackedAgentOptions))
  for (const agent of await loadPythonAgentManifests(options.agentsDir ?? join(home, "agents"), { model: selectedModel })) {
    registry.registerAgent(agent)
  }
  const registeredAgentIds = registry.listAgents().map((agent) => agent.id)
  const configuredDefaultAgentId = resolveRegisteredId(registeredAgentIds, modelConfig.defaultAgentId)
  const defaultAgentId = configuredDefaultAgentId ?? resolveRegisteredId(registeredAgentIds, "see-act") ?? registeredAgentIds[0]
  if (!defaultAgentId) throw new Error("No agents registered")

  const playwrightEnvironment = new PlaywrightEnvironment({ preventFocus: modelConfig.browserPreventFocus })
  registry.registerEnvironment(playwrightEnvironment)
  registry.registerToolAdapter(new PlaywrightBrowserToolAdapter(playwrightEnvironment))
  const registeredEnvironmentIds = registry.listEnvironments().map((environment) => environment.id)
  const configuredDefaultEnvironmentId = resolveRegisteredId(registeredEnvironmentIds, modelConfig.defaultBrowserId)
  const defaultEnvironmentId = configuredDefaultEnvironmentId ?? registeredEnvironmentIds[0]
  if (!defaultEnvironmentId) throw new Error("No browser environments registered")

  const sessions = new Map<string, SessionState>()
  const browserSessions = new BrowserSessionManager({
    eventBus,
    registry,
    defaultEnvironmentId,
  })
  const orchestrator = new RunOrchestrator({
    home,
    eventBus,
    registry,
    agentId: defaultAgentId,
    modelId: defaultModelId,
    environmentId: defaultEnvironmentId,
    maxSteps: 4,
  })
  const storage = new SQLiteStore(join(home, "metadata.sqlite"))
  storage.migrate()
  const app = createApp({
    eventBus,
    orchestrator,
    registry,
    sessions,
    storage,
    browserSessions,
    modelConfigPath: options.configPath,
    runtimeDefaults: {
      agentId: defaultAgentId,
      modelId: modelConfig.defaultModelProvider ? defaultModelId : null,
      environmentId: defaultEnvironmentId,
    },
  })
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
      await browserSessions.closeAll()
      storage.close()
    },
  }
}

function orderModels(models: ModelPlugin[], defaultModelProvider: string | null): ModelPlugin[] {
  if (!defaultModelProvider) return models
  const selected = models.find((model) => model.id === defaultModelProvider)
  if (!selected) return models
  return [selected, ...models.filter((model) => model.id !== defaultModelProvider)]
}

function resolveRegisteredId(ids: string[], configuredId: string | null): string | null {
  if (!configuredId) return null
  return ids.includes(configuredId) ? configuredId : null
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
      throw new Error(
        "No model selected. Configure OPENAI_API_KEY, OPENROUTER_API_KEY, GEMINI_API_KEY, ANTHROPIC_API_KEY, or Codex auth, then use /model <id>.",
      )
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

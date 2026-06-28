import { loadPythonAgentManifests, SeeActAgent, SimpleReActAgent } from "@open-web-agent/agents"
import { PlaywrightBrowserToolAdapter, PlaywrightEnvironment } from "@open-web-agent/browser"
import {
  EventBus,
  PluginRegistry,
  assertSupportedBrowserCapabilities,
  resolveOwaHome,
  RunOrchestrator,
  type ModelPlugin,
  type ModelRequest,
  type ModelResponse,
  type RuntimeContext,
  type SessionState,
} from "@open-web-agent/core"
import {
  CodexOAuthModel,
  createModelPlugin,
  getCatalogModelsByProvider,
  MODEL_CATALOG,
  OpenAICompatibleClient,
  readCodexOAuthToken,
  readModelConfig,
  withChatReasoningEffort,
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
  const env = options.env ?? process.env
  const home = options.home ?? resolveOwaHome(env)
  const eventBus = new EventBus()
  const registry = new PluginRegistry()
  const modelConfig = readModelConfig(env, { configPath: options.configPath })
  const modelCallTimeoutMs = readModelCallTimeoutMs(env)
  const allowPrivateNetworkNavigation =
    readBooleanEnv(env.OPEN_WEB_AGENT_ALLOW_PRIVATE_NETWORK_NAVIGATION, "OPEN_WEB_AGENT_ALLOW_PRIVATE_NETWORK_NAVIGATION") ??
    false

  const models: ModelPlugin[] = []

  if (modelConfig.openaiApiKey) {
    const client = new OpenAICompatibleClient({
      baseUrl: "https://api.openai.com/v1",
      apiKey: modelConfig.openaiApiKey,
      maxRetry: modelConfig.maxRetry,
    })
    for (const entry of getCatalogModelsByProvider("openai")) {
      models.push(
        createModelPlugin(
          { id: entry.id, name: entry.name, provider: "openai", modelName: entry.modelName, reasoningEffort: modelConfig.reasoningEffort, contextWindowTokens: entry.contextWindowTokens },
          (request, ctx) => client.complete(
            withChatReasoningEffort({ ...request, ...modelConfig.parameters, model: entry.modelName }, modelConfig.reasoningEffort),
            { signal: ctx.abortSignal },
          ),
        ),
      )
    }
  }
  if (modelConfig.anthropicApiKey) {
    const client = new OpenAICompatibleClient({
      baseUrl: "https://api.anthropic.com/v1",
      apiKey: modelConfig.anthropicApiKey,
      maxRetry: modelConfig.maxRetry,
    })
    for (const entry of getCatalogModelsByProvider("claude")) {
      models.push(
        createModelPlugin(
          { id: entry.id, name: entry.name, provider: "claude", modelName: entry.modelName, contextWindowTokens: entry.contextWindowTokens },
          (request, ctx) => client.complete(
            { ...request, ...modelConfig.parameters, model: entry.modelName },
            { signal: ctx.abortSignal },
          ),
        ),
      )
    }
  }
  if (modelConfig.geminiApiKey) {
    const client = new OpenAICompatibleClient({
      baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
      apiKey: modelConfig.geminiApiKey,
      maxRetry: modelConfig.maxRetry,
    })
    for (const entry of getCatalogModelsByProvider("gemini")) {
      models.push(
        createModelPlugin(
          { id: entry.id, name: entry.name, provider: "gemini", modelName: entry.modelName, contextWindowTokens: entry.contextWindowTokens },
          (request, ctx) => client.complete(
            { ...request, ...modelConfig.parameters, model: entry.modelName },
            { signal: ctx.abortSignal },
          ),
        ),
      )
    }
  }
  if (modelConfig.openrouterApiKey) {
    const client = new OpenAICompatibleClient({
      baseUrl: "https://openrouter.ai/api/v1",
      apiKey: modelConfig.openrouterApiKey,
      maxRetry: modelConfig.maxRetry,
      defaultHeaders: {
        "http-referer": "https://github.com/open-web-agent/open-web-agent",
        "x-title": "Open Web Agent",
      },
    })
    for (const entry of MODEL_CATALOG) {
      models.push(
        createModelPlugin(
          { id: `openrouter/${entry.modelName}`, name: `${entry.name} (via OpenRouter)`, provider: "openrouter", modelName: entry.modelName, reasoningEffort: modelConfig.reasoningEffort, contextWindowTokens: entry.contextWindowTokens },
          (request, ctx) => client.complete(
            withChatReasoningEffort({ ...request, ...modelConfig.parameters, model: entry.modelName }, modelConfig.reasoningEffort),
            { signal: ctx.abortSignal },
          ),
        ),
      )
    }
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

  const defaultModelId = resolveDefaultModelId(registry, modelConfig)
  const defaultRuntimeModel = defaultModelId ? registry.getModel(defaultModelId) : undefined
  const selectedModel = new RuntimeSelectedModel(registry, defaultModelId)
  const modelBackedAgentOptions = {
    model: selectedModel,
    modelName: defaultRuntimeModel?.modelName ?? modelConfig.defaultModel,
    timeoutMs: modelCallTimeoutMs,
  }
  registry.registerAgent(new SimpleReActAgent(modelBackedAgentOptions))
  registry.registerAgent(new SeeActAgent(modelBackedAgentOptions))
  for (const agent of await loadPythonAgentManifests(options.agentsDir ?? join(home, "agents"), { model: selectedModel })) {
    registry.registerAgent(agent)
  }
  const registeredAgentIds = registry.listAgents().map((agent) => agent.id)
  const configuredDefaultAgentId = resolveRegisteredId(registeredAgentIds, modelConfig.defaultAgentId)
  const defaultAgentId = configuredDefaultAgentId ?? resolveRegisteredId(registeredAgentIds, "see-act") ?? registeredAgentIds[0]
  if (!defaultAgentId) throw new Error("No agents registered")

  const playwrightEnvironment = new PlaywrightEnvironment({
    headless: modelConfig.browserHeadless,
    preventFocus: modelConfig.browserPreventFocus,
  })
  registry.registerEnvironment(playwrightEnvironment)
  const playwrightToolAdapter = new PlaywrightBrowserToolAdapter(playwrightEnvironment, { allowPrivateNetworkNavigation })
  assertSupportedBrowserCapabilities(modelConfig.browserCapabilities, playwrightToolAdapter.supportedCapabilities)
  registry.registerToolAdapter(playwrightToolAdapter)
  const registeredEnvironmentIds = registry.listEnvironments().map((environment) => environment.id)
  const configuredDefaultEnvironmentId = resolveRegisteredId(registeredEnvironmentIds, modelConfig.defaultBrowserId)
  const defaultEnvironmentId = configuredDefaultEnvironmentId ?? registeredEnvironmentIds[0]
  if (!defaultEnvironmentId) throw new Error("No browser environments registered")

  const sessions = new Map<string, SessionState>()
  const browserSessions = new BrowserSessionManager({
    eventBus,
    registry,
    defaultEnvironmentId,
    browserCapabilities: modelConfig.browserCapabilities,
  })
  const orchestrator = new RunOrchestrator({
    home,
    eventBus,
    registry,
    agentId: defaultAgentId,
    modelId: defaultModelId,
    environmentId: defaultEnvironmentId,
    browserCapabilities: modelConfig.browserCapabilities,
    maxSteps: modelConfig.maxSteps,
  })
  const storage = new SQLiteStore(join(home, "metadata.sqlite"))
  storage.migrate()
  const runtimeDefaults = {
    agentId: defaultAgentId,
    modelId: modelConfig.defaultModelProvider ? defaultModelId : null,
    environmentId: defaultEnvironmentId,
    browserHeadless: modelConfig.browserHeadless,
  }
  const app = createApp({
    eventBus,
    orchestrator,
    registry,
    sessions,
    storage,
    browserSessions,
    modelConfigPath: options.configPath,
    modelConfigEnv: env,
    onBrowserHeadlessChanged: async (browserHeadless) => {
      playwrightEnvironment.setHeadless(browserHeadless)
      runtimeDefaults.browserHeadless = browserHeadless
      await browserSessions.closeAll()
    },
    runtimeDefaults,
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
  if (!selected) {
    const providerPrefix = defaultModelProvider.split("/")[0]
    const providerModels = models.filter((model) => model.provider === providerPrefix)
    const otherModels = models.filter((model) => model.provider !== providerPrefix)
    return [...providerModels, ...otherModels]
  }
  return [selected, ...models.filter((model) => model.id !== defaultModelProvider)]
}

function resolveDefaultModelId(registry: PluginRegistry, config: { defaultModelProvider: string | null; defaultModel: string }): string | undefined {
  const models = registry.listModels()
  if (models.length === 0) return undefined

  if (config.defaultModelProvider) {
    const exact = models.find((m) => m.id === config.defaultModelProvider)
    if (exact) return exact.id

    const providerPrefix = config.defaultModelProvider.split("/")[0]
    const byProvider = models.find((m) => m.provider === providerPrefix)
    if (byProvider) return byProvider.id
  }

  if (config.defaultModel) {
    const byName = models.find((m) => m.modelName === config.defaultModel)
    if (byName) return byName.id
  }

  return models[0].id
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

function readBooleanEnv(value: string | undefined, name: string): boolean | undefined {
  if (value == null || value.length === 0) return undefined
  const normalized = value.toLowerCase()
  if (["1", "true", "yes", "on"].includes(normalized)) return true
  if (["0", "false", "no", "off"].includes(normalized)) return false

  throw new Error(`Invalid ${name}: must be a boolean`)
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

    await ctx.emit("model.called", {
      ...metadata,
      toolCount: request.tools?.length ?? 0,
    })
    const response = await model.complete(request, ctx)
    await ctx.emit("model.completed", {
      ...metadata,
      responseMode: response.toolCalls.length > 0 ? "tool_calls" : "text",
      toolCalls: response.toolCalls.map((call) => ({ id: call.id, name: call.name })),
      response: {
        id: response.id,
        usage: response.usage,
        latencyMs: response.latencyMs,
      },
    })
    return response
  }
}

import type { AgentPlugin, ModelPlugin, SessionState } from "@open-web-agent/core"
import type { StoredMessage, StoredSession } from "@open-web-agent/storage"
import type {
  OpenCodeAgent,
  OpenCodeAssistantMessage,
  OpenCodeMessageBundle,
  OpenCodeProvider,
  OpenCodeProviderConfig,
  OpenCodeProviderList,
  OpenCodeSession,
  OpenCodeUserMessage,
} from "./types"

export interface ProjectionDefaults {
  defaultAgentId?: string | null
  defaultModelId?: string | null
}

export interface OpenCodeModelSelection {
  providerID: string
  modelID?: string
  id?: string
}

export function projectProviderConfig(models: ModelPlugin[], defaultModelId?: string | null): OpenCodeProviderConfig {
  const providers = groupProviders(models)
  return {
    providers,
    default: Object.fromEntries(
      providers.flatMap((provider) => {
        const preferred = defaultModelId && provider.models[defaultModelId] ? defaultModelId : Object.keys(provider.models)[0]
        return preferred ? [[provider.id, preferred]] : []
      }),
    ),
  }
}

export function projectProviderList(models: ModelPlugin[], defaultModelId?: string | null): OpenCodeProviderList {
  const config = projectProviderConfig(models, defaultModelId)
  return {
    all: config.providers,
    default: config.default,
    connected: config.providers.map((provider) => provider.id),
  }
}

export function resolveModelId(
  models: ModelPlugin[],
  selection: OpenCodeModelSelection | undefined,
  fallbackModelId?: string | null,
): string | undefined {
  if (selection) {
    const requested = selection.modelID ?? selection.id
    const match = models.find((model) => model.provider === selection.providerID && model.id === requested)
    if (match) return match.id
  }
  if (fallbackModelId && models.some((model) => model.id === fallbackModelId)) return fallbackModelId
  return models[0]?.id
}

export function projectAgents(agents: AgentPlugin[], defaultAgentId?: string | null): OpenCodeAgent[] {
  return orderById(agents, defaultAgentId).map((agent) => ({
    name: agent.id,
    description: agent.description,
    mode: "primary",
    native: true,
    hidden: false,
    permission: [],
    options: {},
  }))
}

export function projectSession(session: StoredSession | SessionState, defaults: ProjectionDefaults): OpenCodeSession {
  const model = defaults.defaultModelId ? parseModel(defaults.defaultModelId) : undefined
  const time = Date.parse(session.createdAt)
  return {
    id: session.id,
    slug: session.id,
    projectID: session.projectHash,
    directory: session.projectPath,
    title: session.title ?? "New session",
    agent: defaults.defaultAgentId ?? undefined,
    model,
    version: "owa",
    time: {
      created: time,
      updated: time,
    },
  }
}

export function projectMessages(
  session: StoredSession | SessionState,
  messages: StoredMessage[],
  defaults: ProjectionDefaults,
): OpenCodeMessageBundle[] {
  const defaultModel = parseMessageModel(defaults.defaultModelId)
  let lastUserMessageId = ""
  return messages.map((message) => {
    const created = Date.parse(message.createdAt)
    if (message.role === "user") {
      lastUserMessageId = message.id
      const info: OpenCodeUserMessage = {
        id: message.id,
        sessionID: message.sessionId,
        role: "user",
        time: { created },
        agent: defaults.defaultAgentId ?? "see-act",
        model: defaultModel,
      }
      return {
        info,
        parts: [textPart(message, created)],
      }
    }

    const info: OpenCodeAssistantMessage = {
      id: message.id,
      sessionID: message.sessionId,
      role: "assistant",
      parentID: lastUserMessageId,
      time: { created, completed: created },
      modelID: defaultModel.modelID,
      providerID: defaultModel.providerID,
      mode: "build",
      agent: defaults.defaultAgentId ?? "see-act",
      path: { cwd: session.projectPath, root: session.projectPath },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    }
    return {
      info,
      parts: [textPart(message, created)],
    }
  })
}

function groupProviders(models: ModelPlugin[]): OpenCodeProvider[] {
  const providers = new Map<string, OpenCodeProvider>()
  for (const model of models) {
    const provider = providers.get(model.provider) ?? {
      id: model.provider,
      name: model.name,
      source: "env" as const,
      env: [],
      options: {},
      models: {},
    }
    provider.models[model.id] = {
      id: model.id,
      name: model.modelName ?? model.name,
      limit: { context: model.contextWindowTokens ?? 0 },
      capabilities: { reasoning: Boolean(model.reasoningEffort) },
    }
    providers.set(provider.id, provider)
  }
  return [...providers.values()]
}

function parseModel(modelId: string): { id: string; providerID: string } {
  return { id: modelId, providerID: modelId.split(":")[0] ?? modelId }
}

function parseMessageModel(modelId: string | null | undefined): { providerID: string; modelID: string } {
  const modelID = modelId ?? "no-model"
  return { providerID: modelID.split(":")[0] ?? modelID, modelID }
}

function textPart(message: StoredMessage, created: number) {
  return {
    id: `part_${message.id}_text`,
    sessionID: message.sessionId,
    messageID: message.id,
    type: "text" as const,
    text: message.content,
    time: { start: created, end: created },
  }
}

function orderById<T extends { id: string }>(items: T[], selectedId?: string | null): T[] {
  if (!selectedId) return items
  const selected = items.find((item) => item.id === selectedId)
  if (!selected) return items
  return [selected, ...items.filter((item) => item.id !== selectedId)]
}

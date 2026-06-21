import type { Hono } from "hono"
import type { PluginRegistry } from "@open-web-agent/core"

export interface PluginRouteDeps {
  registry: PluginRegistry
  defaults?: {
    agentId?: string | null
    modelId?: string | null
    environmentId?: string | null
    browserHeadless?: boolean | null
  }
}

export function registerPluginRoutes(app: Hono, deps: PluginRouteDeps): void {
  app.get("/plugins", (c) =>
    c.json({
      agents: orderBySelectedId(listAgents(deps.registry), deps.defaults?.agentId),
      models: orderBySelectedId(listModels(deps.registry), deps.defaults?.modelId),
      environments: orderBySelectedId(listEnvironments(deps.registry), deps.defaults?.environmentId),
      defaults: omitNullish({
        agentId: deps.defaults?.agentId ?? null,
        modelId: deps.defaults?.modelId ?? null,
        environmentId: deps.defaults?.environmentId ?? null,
        browserHeadless: deps.defaults?.browserHeadless ?? null,
      }),
    }),
  )

  app.get("/plugins/agents", (c) => c.json({ agents: orderBySelectedId(listAgents(deps.registry), deps.defaults?.agentId) }))
  app.get("/plugins/models", (c) => c.json({ models: orderBySelectedId(listModels(deps.registry), deps.defaults?.modelId) }))
  app.get("/plugins/environments", (c) =>
    c.json({ environments: orderBySelectedId(listEnvironments(deps.registry), deps.defaults?.environmentId) }),
  )
}

function listAgents(registry: PluginRegistry) {
  return registry.listAgents().map((agent) => ({
    id: agent.id,
    name: agent.name,
    description: agent.description,
  }))
}

function listModels(registry: PluginRegistry) {
  return registry.listModels().map((model) => ({
    id: model.id,
    name: model.name,
    provider: model.provider,
    modelName: model.modelName,
    reasoningEffort: model.reasoningEffort,
    contextWindowTokens: model.contextWindowTokens ?? null,
  }))
}

function listEnvironments(registry: PluginRegistry) {
  return registry.listEnvironments().map((environment) => ({
    id: environment.id,
    name: environment.name,
  }))
}

function orderBySelectedId<T extends { id: string }>(items: T[], selectedId?: string | null): T[] {
  if (!selectedId) return items
  const selected = items.find((item) => item.id === selectedId)
  if (!selected) return items
  return [selected, ...items.filter((item) => item.id !== selectedId)]
}

function omitNullish<T extends Record<string, unknown>>(record: T): Partial<T> {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value != null)) as Partial<T>
}

import type { Hono } from "hono"
import type { PluginRegistry } from "@open-web-agent/core"

export interface PluginRouteDeps {
  registry: PluginRegistry
}

export function registerPluginRoutes(app: Hono, deps: PluginRouteDeps): void {
  app.get("/plugins", (c) =>
    c.json({
      agents: listAgents(deps.registry),
      models: listModels(deps.registry),
      environments: listEnvironments(deps.registry),
    }),
  )

  app.get("/plugins/agents", (c) => c.json({ agents: listAgents(deps.registry) }))
  app.get("/plugins/models", (c) => c.json({ models: listModels(deps.registry) }))
  app.get("/plugins/environments", (c) => c.json({ environments: listEnvironments(deps.registry) }))
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
  }))
}

function listEnvironments(registry: PluginRegistry) {
  return registry.listEnvironments().map((environment) => ({
    id: environment.id,
    name: environment.name,
  }))
}

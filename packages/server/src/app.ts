import { Hono } from "hono"
import type { EventBus, PluginRegistry, RunOrchestrator, SessionState } from "@open-web-agent/core"
import type { SQLiteStore } from "@open-web-agent/storage"
import { registerEventRoutes } from "./routes/events"
import { registerHealthRoutes } from "./routes/health"
import { registerPluginRoutes } from "./routes/plugins"
import { registerRunRoutes, type RunRecord } from "./routes/runs"
import { registerSessionRoutes } from "./routes/sessions"
import { registerConfigRoutes } from "./routes/config"

export interface CreateAppDeps {
  eventBus: EventBus
  orchestrator: RunOrchestrator
  registry: PluginRegistry
  sessions: Map<string, SessionState>
  storage?: SQLiteStore
  modelConfigPath?: string
}

export function createApp(deps: CreateAppDeps): Hono {
  const app = new Hono()
  const runs = new Map<string, RunRecord>()

  registerHealthRoutes(app)
  registerEventRoutes(app, { eventBus: deps.eventBus })
  registerSessionRoutes(app, { sessions: deps.sessions, runs, storage: deps.storage })
  registerRunRoutes(app, {
    orchestrator: deps.orchestrator,
    registry: deps.registry,
    sessions: deps.sessions,
    runs,
    storage: deps.storage,
  })
  registerConfigRoutes(app, { registry: deps.registry, modelConfigPath: deps.modelConfigPath })
  registerPluginRoutes(app, { registry: deps.registry })

  return app
}

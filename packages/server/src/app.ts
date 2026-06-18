import { Hono } from "hono"
import type { EventBus, PluginRegistry, RunOrchestrator, SessionState } from "@open-web-agent/core"
import type { SQLiteStore } from "@open-web-agent/storage"
import { BrowserSessionManager } from "./browser-session-manager"
import { registerConfigRoutes } from "./routes/config"
import { registerEventRoutes } from "./routes/events"
import { registerHealthRoutes } from "./routes/health"
import { registerPluginRoutes } from "./routes/plugins"
import { registerRunRoutes, type RunRecord } from "./routes/runs"
import { registerSessionRoutes } from "./routes/sessions"

export interface CreateAppDeps {
  eventBus: EventBus
  orchestrator: RunOrchestrator
  registry: PluginRegistry
  sessions: Map<string, SessionState>
  storage?: SQLiteStore
  browserSessions?: BrowserSessionManager
  modelConfigPath?: string
  runtimeDefaults?: {
    agentId?: string | null
    modelId?: string | null
    environmentId?: string | null
  }
}

export function createApp(deps: CreateAppDeps): Hono {
  const app = new Hono()
  const runs = new Map<string, RunRecord>()
  const browserSessions =
    deps.browserSessions ??
    new BrowserSessionManager({
      eventBus: deps.eventBus,
      registry: deps.registry,
      defaultEnvironmentId: deps.orchestrator.defaultEnvironmentId,
    })

  registerHealthRoutes(app)
  registerEventRoutes(app, { eventBus: deps.eventBus })
  registerSessionRoutes(app, { sessions: deps.sessions, runs, storage: deps.storage, registry: deps.registry, browserSessions })
  registerRunRoutes(app, {
    orchestrator: deps.orchestrator,
    registry: deps.registry,
    sessions: deps.sessions,
    runs,
    storage: deps.storage,
    browserSessions,
  })
  registerConfigRoutes(app, { registry: deps.registry, modelConfigPath: deps.modelConfigPath })
  registerPluginRoutes(app, { registry: deps.registry, defaults: deps.runtimeDefaults })

  return app
}

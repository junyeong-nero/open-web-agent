import { Hono } from "hono"
import type { EventBus, PluginRegistry, RunOrchestrator, SessionState } from "@open-web-agent/core"
import type { SQLiteStore } from "@open-web-agent/storage"
import { registerEventRoutes } from "./routes/events"
import { registerHealthRoutes } from "./routes/health"
import { registerPluginRoutes } from "./routes/plugins"
import { registerRunRoutes, type RunRecord } from "./routes/runs"
import { registerSessionRoutes } from "./routes/sessions"
import { BrowserSessionManager } from "./browser-session-manager"

export interface CreateAppDeps {
  eventBus: EventBus
  orchestrator: RunOrchestrator
  registry: PluginRegistry
  sessions: Map<string, SessionState>
  storage?: SQLiteStore
  browserSessions?: BrowserSessionManager
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
  registerPluginRoutes(app, { registry: deps.registry })

  return app
}

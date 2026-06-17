import { Hono } from "hono"
import type { EventBus, PluginRegistry, RunOrchestrator, SessionState } from "@open-web-agent/core"
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
}

export function createApp(deps: CreateAppDeps): Hono {
  const app = new Hono()
  const runs = new Map<string, RunRecord>()

  registerHealthRoutes(app)
  registerEventRoutes(app, { eventBus: deps.eventBus })
  registerSessionRoutes(app, { sessions: deps.sessions })
  registerRunRoutes(app, {
    orchestrator: deps.orchestrator,
    sessions: deps.sessions,
    runs,
  })
  registerPluginRoutes(app, { registry: deps.registry })

  return app
}

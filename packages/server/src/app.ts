import { Hono } from "hono"
import type { EventBus, PluginRegistry, RunOrchestrator, SessionState } from "@open-web-agent/core"
import type { SQLiteStore } from "@open-web-agent/storage"
import { BrowserSessionManager } from "./browser-session-manager"
import { registerConfigRoutes } from "./routes/config"
import { registerEventRoutes } from "./routes/events"
import { registerHealthRoutes } from "./routes/health"
import { registerOpenCodeRoutes } from "./routes/opencode"
import { registerPluginRoutes } from "./routes/plugins"
import { registerRunRoutes, type RunRecord } from "./routes/runs"
import { registerSessionRoutes } from "./routes/sessions"
import { rejectUntrustedLocalRequest } from "./request-guard"

export interface CreateAppDeps {
  eventBus: EventBus
  orchestrator: RunOrchestrator
  registry: PluginRegistry
  sessions: Map<string, SessionState>
  storage?: SQLiteStore
  browserSessions?: BrowserSessionManager
  modelConfigPath?: string
  modelConfigEnv?: NodeJS.ProcessEnv
  onBrowserHeadlessChanged?: (browserHeadless: boolean) => void | Promise<void>
  runtimeDefaults?: {
    agentId?: string | null
    modelId?: string | null
    environmentId?: string | null
    browserHeadless?: boolean | null
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
      browserCapabilities: ["core"],
    })

  app.use("*", async (c, next) => {
    const rejection = rejectUntrustedLocalRequest(c.req.raw)
    if (rejection) return c.json({ error: rejection.error }, rejection.status)
    await next()
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
  registerConfigRoutes(app, {
    registry: deps.registry,
    modelConfigPath: deps.modelConfigPath,
    modelConfigEnv: deps.modelConfigEnv,
    onBrowserHeadlessChanged: deps.onBrowserHeadlessChanged,
  })
  registerPluginRoutes(app, { registry: deps.registry, defaults: deps.runtimeDefaults })
  registerOpenCodeRoutes(app, {
    eventBus: deps.eventBus,
    registry: deps.registry,
    sessions: deps.sessions,
    runs,
    storage: deps.storage,
    defaults: deps.runtimeDefaults,
  })

  return app
}

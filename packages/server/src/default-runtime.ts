import { MockAgent } from "@open-web-agent/agents"
import { MockEnvironment } from "@open-web-agent/browser"
import { EventBus, PluginRegistry, resolveOwaHome, RunOrchestrator, type SessionState } from "@open-web-agent/core"
import { SQLiteStore } from "@open-web-agent/storage"
import { join } from "node:path"
import { createApp } from "./app"
import { startServer, type StartedServer } from "./start-server"

export interface StartDefaultRuntimeOptions {
  home?: string
  hostname?: string
  port?: number
  environmentDelayMs?: number
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
  registry.registerAgent(new MockAgent())
  registry.registerEnvironment(new MockEnvironment(options.environmentDelayMs))

  const sessions = new Map<string, SessionState>()
  const orchestrator = new RunOrchestrator({
    home,
    eventBus,
    registry,
    agentId: "mock-agent",
    environmentId: "mock-browser",
    maxSteps: 4,
  })
  const storage = new SQLiteStore(join(home, "metadata.sqlite"))
  storage.migrate()
  const app = createApp({ eventBus, orchestrator, registry, sessions, storage })
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
      storage.close()
    },
  }
}

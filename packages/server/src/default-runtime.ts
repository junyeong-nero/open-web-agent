import { MockAgent } from "@open-web-agent/agents"
import { MockEnvironment } from "@open-web-agent/browser"
import { EventBus, PluginRegistry, resolveOwaHome, RunOrchestrator, type SessionState } from "@open-web-agent/core"
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
  server: StartedServer
  stop(): Promise<void>
}

export async function startDefaultRuntime(options: StartDefaultRuntimeOptions = {}): Promise<StartedDefaultRuntime> {
  const eventBus = new EventBus()
  const registry = new PluginRegistry()
  registry.registerAgent(new MockAgent())
  registry.registerEnvironment(new MockEnvironment(options.environmentDelayMs))

  const sessions = new Map<string, SessionState>()
  const orchestrator = new RunOrchestrator({
    home: options.home ?? resolveOwaHome(),
    eventBus,
    registry,
    agentId: "mock-agent",
    environmentId: "mock-browser",
    maxSteps: 4,
  })
  const app = createApp({ eventBus, orchestrator, registry, sessions })
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
    server,
    stop: () => server.stop(),
  }
}

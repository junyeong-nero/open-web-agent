import type { AgentPlugin, BrowserEnvironment, ModelPlugin } from "../contracts/plugin"

export class PluginRegistry {
  private agents = new Map<string, AgentPlugin>()
  private environments = new Map<string, BrowserEnvironment>()
  private models = new Map<string, ModelPlugin>()

  registerAgent(plugin: AgentPlugin): void {
    this.register(this.agents, plugin)
  }

  registerEnvironment(plugin: BrowserEnvironment): void {
    this.register(this.environments, plugin)
  }

  registerModel(plugin: ModelPlugin): void {
    this.register(this.models, plugin)
  }

  getAgent(id: string): AgentPlugin {
    return this.get(this.agents, id, "agent")
  }

  getEnvironment(id: string): BrowserEnvironment {
    return this.get(this.environments, id, "environment")
  }

  getModel(id: string): ModelPlugin {
    return this.get(this.models, id, "model")
  }

  listAgents(): AgentPlugin[] {
    return [...this.agents.values()]
  }

  listEnvironments(): BrowserEnvironment[] {
    return [...this.environments.values()]
  }

  listModels(): ModelPlugin[] {
    return [...this.models.values()]
  }

  private register<T extends { id: string }>(map: Map<string, T>, plugin: T): void {
    if (map.has(plugin.id)) throw new Error(`Plugin already registered: ${plugin.id}`)
    map.set(plugin.id, plugin)
  }

  private get<T>(map: Map<string, T>, id: string, kind: string): T {
    const plugin = map.get(id)
    if (!plugin) throw new Error(`Unknown ${kind}: ${id}`)
    return plugin
  }
}

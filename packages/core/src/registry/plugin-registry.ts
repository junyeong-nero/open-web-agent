import type { AgentPlugin, BrowserEnvironment, ModelPlugin, ToolAdapter } from "../contracts/plugin"

export class PluginRegistry {
  private agents = new Map<string, AgentPlugin>()
  private environments = new Map<string, BrowserEnvironment>()
  private models = new Map<string, ModelPlugin>()
  private toolAdapters = new Map<string, ToolAdapter>()
  private toolAdaptersByEnvironment = new Map<string, ToolAdapter>()

  registerAgent(plugin: AgentPlugin): void {
    this.register(this.agents, plugin)
  }

  registerEnvironment(plugin: BrowserEnvironment): void {
    this.register(this.environments, plugin)
  }

  registerModel(plugin: ModelPlugin): void {
    this.register(this.models, plugin)
  }

  registerToolAdapter(plugin: ToolAdapter): void {
    if (this.toolAdapters.has(plugin.id)) throw new Error(`Plugin already registered: ${plugin.id}`)
    if (this.toolAdaptersByEnvironment.has(plugin.environmentId)) {
      throw new Error(`Tool adapter already registered for environment: ${plugin.environmentId}`)
    }

    this.toolAdapters.set(plugin.id, plugin)
    this.toolAdaptersByEnvironment.set(plugin.environmentId, plugin)
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

  getToolAdapterForEnvironment(environmentId: string): ToolAdapter {
    const plugin = this.toolAdaptersByEnvironment.get(environmentId)
    if (!plugin) throw new Error(`Unknown tool adapter for environment: ${environmentId}`)
    return plugin
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

  listToolAdapters(): ToolAdapter[] {
    return [...this.toolAdapters.values()]
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

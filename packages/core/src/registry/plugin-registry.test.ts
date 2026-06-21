import { describe, expect, it } from "bun:test"
import type { AgentPlugin, BrowserEnvironment, ModelPlugin, ToolAdapter } from "../contracts/plugin"
import { PluginRegistry } from "./plugin-registry"

const agent: AgentPlugin = {
  id: "agent-1",
  name: "Agent 1",
  description: "Test agent.",
  async initialize() {},
  async step() {
    return { type: "final_answer", thought: null, finalAnswer: "done", confidence: 1 }
  },
  async finalize() {
    return "done"
  },
}

const environment: BrowserEnvironment = {
  id: "env-1",
  name: "Env 1",
  async reset() {},
  async observe() {
    return { url: "about:blank", title: null, text: null, screenshotPath: null, interactiveElements: [], metadata: {} }
  },
  async close() {},
}

const model: ModelPlugin = {
  id: "model-1",
  name: "Model 1",
  provider: "test",
  async complete() {
    return { id: "response-1", text: "done", raw: {}, usage: null, latencyMs: 0 }
  },
}

const toolAdapter: ToolAdapter = {
  id: "tool-adapter-1",
  name: "Tool Adapter 1",
  environmentId: "env-1",
  listTools() {
    return []
  },
  async execute() {
    return { ok: true, message: "executed", observation: null, metadata: {} }
  },
}

describe("PluginRegistry", () => {
  it("registers and lists plugins by kind", () => {
    const registry = new PluginRegistry()

    registry.registerAgent(agent)
    registry.registerEnvironment(environment)
    registry.registerModel(model)
    registry.registerToolAdapter(toolAdapter)

    expect(registry.getAgent("agent-1")).toBe(agent)
    expect(registry.getEnvironment("env-1")).toBe(environment)
    expect(registry.getModel("model-1")).toBe(model)
    expect(registry.getToolAdapterForEnvironment("env-1")).toBe(toolAdapter)
    expect(registry.listAgents()).toEqual([agent])
    expect(registry.listEnvironments()).toEqual([environment])
    expect(registry.listModels()).toEqual([model])
    expect(registry.listToolAdapters()).toEqual([toolAdapter])
  })

  it("throws on duplicate plugin IDs", () => {
    const registry = new PluginRegistry()

    registry.registerAgent(agent)
    registry.registerToolAdapter(toolAdapter)

    expect(() => registry.registerAgent(agent)).toThrow("Plugin already registered: agent-1")
    expect(() => registry.registerToolAdapter(toolAdapter)).toThrow("Plugin already registered: tool-adapter-1")
  })

  it("throws when a plugin is unknown", () => {
    const registry = new PluginRegistry()

    expect(() => registry.getAgent("missing")).toThrow("Unknown agent: missing")
    expect(() => registry.getToolAdapterForEnvironment("missing")).toThrow("Unknown tool adapter for environment: missing")
  })
})

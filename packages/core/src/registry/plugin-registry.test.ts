import { describe, expect, it } from "bun:test"
import type { AgentPlugin, BrowserEnvironment, ModelPlugin } from "../contracts/plugin"
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
  async execute() {
    return { ok: true, message: null, observation: null, metadata: {} }
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

describe("PluginRegistry", () => {
  it("registers and lists plugins by kind", () => {
    const registry = new PluginRegistry()

    registry.registerAgent(agent)
    registry.registerEnvironment(environment)
    registry.registerModel(model)

    expect(registry.getAgent("agent-1")).toBe(agent)
    expect(registry.getEnvironment("env-1")).toBe(environment)
    expect(registry.getModel("model-1")).toBe(model)
    expect(registry.listAgents()).toEqual([agent])
    expect(registry.listEnvironments()).toEqual([environment])
    expect(registry.listModels()).toEqual([model])
  })

  it("throws on duplicate plugin IDs", () => {
    const registry = new PluginRegistry()

    registry.registerAgent(agent)

    expect(() => registry.registerAgent(agent)).toThrow("Plugin already registered: agent-1")
  })

  it("throws when a plugin is unknown", () => {
    const registry = new PluginRegistry()

    expect(() => registry.getAgent("missing")).toThrow("Unknown agent: missing")
  })
})

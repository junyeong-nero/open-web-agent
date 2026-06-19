import { describe, expect, it } from "bun:test"
import { reduceRuntimeSelectionSuccess } from "./runtime-selection"
import { createInitialState, reduceTuiEvent } from "./state/reducer"

describe("reduceRuntimeSelectionSuccess", () => {
  it("updates selected runtime options without appending system transcript messages", () => {
    const initial = activeRuntimeState()

    const withModel = reduceRuntimeSelectionSuccess(initial, {
      kind: "model",
      modelId: "model-two",
      reasoningEffort: "high",
    })
    const withAgent = reduceRuntimeSelectionSuccess(withModel, { kind: "agent", agentId: "agent-two" })
    const withBrowser = reduceRuntimeSelectionSuccess(withAgent, { kind: "browser", environmentId: "browser-two" })

    expect(withBrowser.selectedModelId).toBe("model-two")
    expect(withBrowser.availableModels.find((model) => model.id === "model-two")?.reasoningEffort).toBe("high")
    expect(withBrowser.selectedAgentId).toBe("agent-two")
    expect(withBrowser.selectedEnvironmentId).toBe("browser-two")
    expect(withBrowser.conversation).toEqual([])
    expect(withBrowser.runLog).toEqual([])
  })
})

function activeRuntimeState() {
  const withSession = reduceTuiEvent(createInitialState("/tmp/project"), { type: "session.created", sessionId: "ses_1" })
  return reduceTuiEvent(withSession, {
    type: "plugins.loaded",
    agents: [
      { id: "agent-one", name: "Agent One", description: "Initial agent" },
      { id: "agent-two", name: "Agent Two", description: "Selected agent" },
    ],
    models: [
      { id: "model-one", name: "Model One", provider: "test", modelName: "model-one", reasoningEffort: "medium" },
      { id: "model-two", name: "Model Two", provider: "test", modelName: "model-two", reasoningEffort: "medium" },
    ],
    environments: [
      { id: "browser-one", name: "Browser One" },
      { id: "browser-two", name: "Browser Two" },
    ],
  })
}

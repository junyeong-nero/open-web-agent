import { describe, expect, it } from "bun:test"
import type { RunEvent } from "@open-web-agent/core"
import { createInitialState, reduceTuiEvent } from "./reducer"

function event(type: RunEvent["type"], payload: Record<string, unknown> = {}): RunEvent {
  return {
    id: `evt_${type}`,
    runId: "run_1",
    sessionId: "ses_1",
    stepId: null,
    sequence: 1,
    type,
    payload,
    createdAt: "2026-06-17T00:00:00.000Z",
  }
}

describe("reduceTuiEvent", () => {
  it("uses opencode shell defaults", () => {
    expect(createInitialState("/tmp/project")).toMatchObject({
      selectedAgentId: "mock-agent",
      selectedModelId: null,
      selectedEnvironmentId: "mock-browser",
      selectedThemeId: "opencode",
      availableAgents: [],
      availableModels: [],
      availableEnvironments: [],
    })
  })

  it("adds timeline item for browser action events", () => {
    const state = reduceTuiEvent(createInitialState("/tmp/project"), {
      type: "run.event",
      event: event("browser.action.started", {
        action: { id: "action_1", kind: "inspect_page_title" },
      }),
    })

    expect(state.timeline).toEqual([
      {
        eventId: "evt_browser.action.started",
        sequence: 1,
        type: "browser.action.started",
        label: "inspect_page_title",
      },
    ])
  })

  it("appends final answer on run.completed", () => {
    const state = reduceTuiEvent(createInitialState("/tmp/project"), {
      type: "run.event",
      event: event("run.completed", { finalAnswer: '페이지 제목은 "Example Domain"입니다.' }),
    })

    expect(state.runStatus).toBe("completed")
    expect(state.conversation).toContainEqual({
      role: "assistant",
      content: '페이지 제목은 "Example Domain"입니다.',
    })
  })

  it("stores plan items on plan.created", () => {
    const state = reduceTuiEvent(createInitialState("/tmp/project"), {
      type: "run.event",
      event: event("plan.created", { items: [{ id: "plan_1", title: "Open page", status: "pending" }] }),
    })

    expect(state.plan).toEqual([{ id: "plan_1", title: "Open page", status: "pending" }])
  })

  it("replaces plan items on plan.updated", () => {
    const withPlan = reduceTuiEvent(createInitialState("/tmp/project"), {
      type: "run.event",
      event: event("plan.created", { items: [{ id: "plan_1", title: "Open page", status: "pending" }] }),
    })

    const state = reduceTuiEvent(withPlan, {
      type: "run.event",
      event: event("plan.updated", { items: [{ id: "plan_2", title: "Retry click", status: "active" }] }),
    })

    expect(state.plan).toEqual([{ id: "plan_2", title: "Retry click", status: "active" }])
  })

  it("clears local view state while preserving session and run controls", () => {
    const initial = createInitialState("/tmp/project")
    const withSession = reduceTuiEvent(initial, { type: "session.created", sessionId: "ses_1" })
    const running = reduceTuiEvent(withSession, { type: "run.event", event: event("run.started") })
    const withConversation = reduceTuiEvent(running, {
      type: "conversation.append",
      message: { role: "user", content: "find the title" },
    })
    const withTimeline = reduceTuiEvent(withConversation, {
      type: "run.event",
      event: event("observation.captured", {
        observation: {
          url: "https://example.com",
          title: "Example Domain",
          text: "Example Domain",
          screenshotPath: "/tmp/example.png",
          interactiveElements: [],
          metadata: {},
        },
      }),
    })

    const state = reduceTuiEvent(withTimeline, { type: "state.clear" })

    expect(state.projectPath).toBe("/tmp/project")
    expect(state.activeSessionId).toBe("ses_1")
    expect(state.activeRunId).toBe("run_1")
    expect(state.runStatus).toBe("running")
    expect(state.inspectorVisible).toBe(true)
    expect(state.selectedEvent).toBeNull()
    expect(state.conversation).toEqual([])
    expect(state.timeline).toEqual([])
    expect(state.runLog).toEqual([])
    expect(state.plan).toEqual([])
    expect(state.browser.url).toBe("about:blank")
  })

  it("stores available and selected runtime plugins", () => {
    const loaded = reduceTuiEvent(createInitialState("/tmp/project"), {
      type: "plugins.loaded",
      agents: [
        { id: "mock-agent", name: "Mock Agent", description: "Deterministic" },
        { id: "plan-act-agent", name: "PlanAct Agent", description: "Plans first" },
      ],
      models: [
        {
          id: "openai",
          name: "OpenAI",
          provider: "openai",
          modelName: "gpt-test",
          reasoningEffort: "medium",
          contextWindowTokens: 128000,
        },
        { id: "openrouter", name: "OpenRouter", provider: "openrouter", modelName: "openai/gpt-test" },
      ],
      environments: [
        { id: "mock-browser", name: "Mock Browser" },
        { id: "playwright-browser", name: "Playwright Browser" },
      ],
    })
    const selectedAgent = reduceTuiEvent(loaded, { type: "agent.selected", agentId: "plan-act-agent" })
    const selectedModel = reduceTuiEvent(selectedAgent, { type: "model.selected", modelId: "openrouter" })
    const selectedBrowser = reduceTuiEvent(selectedModel, { type: "environment.selected", environmentId: "playwright-browser" })

    expect(loaded.selectedAgentId).toBe("mock-agent")
    expect(loaded.selectedModelId).toBe("openai")
    expect(loaded.selectedEnvironmentId).toBe("mock-browser")
    expect(selectedBrowser.selectedAgentId).toBe("plan-act-agent")
    expect(selectedBrowser.selectedModelId).toBe("openrouter")
    expect(selectedBrowser.selectedEnvironmentId).toBe("playwright-browser")
    expect(selectedBrowser.availableAgents.map((agent) => agent.id)).toEqual(["mock-agent", "plan-act-agent"])
    expect(selectedBrowser.availableModels.map((model) => model.id)).toEqual(["openai", "openrouter"])
    expect(selectedBrowser.availableModels[0]).toMatchObject({
      modelName: "gpt-test",
      reasoningEffort: "medium",
      contextWindowTokens: 128000,
    })
    expect(selectedBrowser.availableEnvironments.map((environment) => environment.id)).toEqual(["mock-browser", "playwright-browser"])
  })

  it("tracks model inference activity and context usage from model events", () => {
    const loaded = reduceTuiEvent(createInitialState("/tmp/project"), {
      type: "plugins.loaded",
      agents: [],
      models: [
        {
          id: "openai",
          name: "OpenAI",
          provider: "openai",
          modelName: "gpt-test",
          reasoningEffort: "high",
          contextWindowTokens: 400000,
        },
      ],
      environments: [],
    })
    const called = reduceTuiEvent(loaded, {
      type: "run.event",
      event: event("model.called", {
        modelId: "openai",
        modelName: "gpt-test",
        provider: "openai",
        reasoningEffort: "high",
        contextWindowTokens: 400000,
      }),
    })
    const completed = reduceTuiEvent(called, {
      type: "run.event",
      event: event("model.completed", {
        modelId: "openai",
        modelName: "gpt-test",
        provider: "openai",
        reasoningEffort: "high",
        contextWindowTokens: 400000,
        response: {
          usage: { inputTokens: 7200, outputTokens: 40, totalTokens: 7240 },
          latencyMs: 1200,
        },
      }),
    })

    expect(called.modelActivity.status).toBe("running")
    expect(called.modelActivity.modelName).toBe("gpt-test")
    expect(completed.modelActivity.status).toBe("idle")
    expect(completed.modelActivity.usage).toEqual({ inputTokens: 7200, outputTokens: 40, totalTokens: 7240 })
    expect(completed.modelActivity.contextWindowTokens).toBe(400000)
  })

  it("stores selected theme", () => {
    const state = reduceTuiEvent(createInitialState("/tmp/project"), { type: "theme.selected", themeId: "aurora-violet" })

    expect(state.selectedThemeId).toBe("aurora-violet")
  })

  it("stores system command responses in the linear run log", () => {
    const state = reduceTuiEvent(createInitialState("/tmp/project"), {
      type: "conversation.append",
      message: { role: "system", content: "Theme set to opencode" },
    })

    expect(state.runLog).toContainEqual({
      id: "system-0",
      sequence: 0,
      kind: "system",
      message: "Theme set to opencode",
      accent: "warning",
    })
  })

  it("stores linear run log entries from run events", () => {
    const started = reduceTuiEvent(createInitialState("/tmp/project"), {
      type: "run.event",
      event: event("run.started", { prompt: "Open example.com" }),
    })
    const tool = reduceTuiEvent(started, {
      type: "run.event",
      event: event("browser.tool.completed", {
        toolCall: { id: "tool_1", type: "navigate", url: "https://example.com" },
        result: { ok: true, message: "navigated", observation: null, metadata: {} },
      }),
    })
    const completed = reduceTuiEvent(tool, {
      type: "run.event",
      event: event("run.completed", { finalAnswer: "Example Domain" }),
    })

    expect(completed.runLog.map((item) => [item.kind, item.message])).toEqual([
      ["user.task", "Open example.com"],
      ["tool.result", "navigate ok navigated"],
      ["agent.answer", "Example Domain"],
    ])
  })

  it("ignores duplicate run events when storing timeline and run log entries", () => {
    const runStarted = event("run.started", { prompt: "Open example.com" })
    const once = reduceTuiEvent(createInitialState("/tmp/project"), { type: "run.event", event: runStarted })
    const twice = reduceTuiEvent(once, { type: "run.event", event: runStarted })

    expect(twice.timeline.map((item) => item.eventId)).toEqual(["evt_run.started"])
    expect(twice.runLog.map((item) => item.id)).toEqual(["evt_run.started"])
  })
})

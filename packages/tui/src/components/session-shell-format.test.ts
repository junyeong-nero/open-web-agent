import { describe, expect, it } from "bun:test"
import type { TuiState } from "../state/types"
import { createInitialState } from "../state/reducer"
import {
  formatContextUsage,
  promptHint,
  promptMeta,
  selectedAgentSummary,
  sessionMeta,
  sessionTitle,
  toTranscriptViewItem,
} from "./session-shell-format"

function stateWithLog(): TuiState {
  return {
    ...createInitialState("/work/open-web-agent"),
    selectedAgentId: "mock-agent",
    selectedModelId: null,
    selectedEnvironmentId: "mock-browser",
    runStatus: "completed",
    runLog: [
      {
        id: "run-started",
        sequence: 0,
        kind: "user.task",
        message: "Open example.com",
        accent: "task",
      },
      {
        id: "tool-result",
        sequence: 1,
        kind: "tool.result",
        message: "navigate ok navigated",
        accent: "tool",
      },
      {
        id: "answer",
        sequence: 2,
        kind: "agent.answer",
        message: "Example Domain",
        accent: "answer",
      },
    ],
  }
}

describe("session shell formatting", () => {
  it("uses the latest user task as the session title", () => {
    expect(sessionTitle(stateWithLog())).toBe("Open example.com")
    expect(sessionTitle(createInitialState("/work/open-web-agent"))).toBe("open-web-agent workflow")
  })

  it("formats compact session metadata", () => {
    expect(sessionMeta(stateWithLog())).toBe("completed · mock-agent · mock-browser")
  })

  it("resolves the selected agent display name with id fallback", () => {
    expect(
      selectedAgentSummary({
        ...stateWithLog(),
        selectedAgentId: "plan-act-agent",
        availableAgents: [{ id: "plan-act-agent", name: "PlanAct Agent", description: "Plans before acting." }],
      }),
    ).toMatchObject({ id: "plan-act-agent", name: "PlanAct Agent" })
    expect(selectedAgentSummary({ ...stateWithLog(), selectedAgentId: "see-act", availableAgents: [] })).toMatchObject({
      id: "see-act",
      name: "see-act",
    })
  })

  it("classifies transcript rows for OpenCode-style rendering", () => {
    expect(toTranscriptViewItem(stateWithLog().runLog[0]!)).toMatchObject({
      block: "user",
      prefix: "",
      text: "Open example.com",
    })
    expect(toTranscriptViewItem(stateWithLog().runLog[1]!)).toMatchObject({
      block: "tool",
      prefix: "*",
      text: "navigate ok navigated",
    })
    expect(toTranscriptViewItem({ id: "failed", sequence: 3, kind: "run.failed", message: "boom", accent: "danger" })).toMatchObject({
      block: "status",
      prefix: "~",
      text: "failed boom",
    })
  })

  it("formats prompt metadata and hints", () => {
    const agent = { id: "plan-act-agent", name: "PlanAct Agent", description: "Plans before acting." }

    expect(promptMeta(null, null)).toBe("no agent / no model")
    expect(promptMeta({ id: "see-act", name: "see-act", description: "" }, null)).toBe("see-act / no model")
    expect(
      promptMeta(agent, {
        id: "openai",
        name: "OpenAI",
        provider: "openai",
        modelName: "GPT-5.5",
        reasoningEffort: "xhigh",
      }),
    ).toBe("PlanAct / GPT-5.5 / xhigh")
    expect(
      promptMeta(agent, {
        id: "openrouter",
        name: "OpenRouter",
        provider: "openrouter",
        modelName: "GPT-5.5",
        reasoningEffort: null,
      }),
    ).toBe("PlanAct / GPT-5.5")
    expect(promptHint("running", "7.2K (2%)")).toBe("7.2K (2%)  esc interrupt")
    expect(promptHint("idle", "0 (0%)")).toBe("0 (0%)  esc exit")
  })

  it("formats context usage as token count and percentage", () => {
    expect(
      formatContextUsage({
        usage: { inputTokens: 7200, outputTokens: 40, totalTokens: 7240 },
        contextWindowTokens: 400000,
      }),
    ).toBe("7.2K (2%)")
    expect(formatContextUsage({ usage: null, contextWindowTokens: 128000 })).toBe("0 (0%)")
  })
})

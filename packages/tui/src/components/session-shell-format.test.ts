import { describe, expect, it } from "bun:test"
import type { TuiState } from "../state/types"
import { createInitialState } from "../state/reducer"
import {
  promptHint,
  promptMeta,
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
    expect(promptMeta("mock-agent", null)).toBe("Build mock-agent no-model open-web-agent")
    expect(promptMeta("plan-act-agent", "openrouter")).toBe("Build plan-act-agent openrouter open-web-agent")
    expect(promptHint("running")).toBe("esc interrupt")
    expect(promptHint("idle")).toBe("esc exit")
  })
})

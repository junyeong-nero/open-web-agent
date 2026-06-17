import { describe, expect, it } from "bun:test"
import type { RunEvent } from "@open-web-agent/core"
import { toRunLogItem } from "./run-log"

function event(type: RunEvent["type"], payload: Record<string, unknown> = {}): RunEvent {
  return {
    id: `evt_${type}`,
    runId: "run_1",
    sessionId: "ses_1",
    stepId: null,
    sequence: 7,
    type,
    payload,
    createdAt: "2026-06-17T00:00:00.000Z",
  }
}

describe("toRunLogItem", () => {
  it("formats task, reasoning, tool, and answer events", () => {
    expect(toRunLogItem(event("run.started", { prompt: "Open example.com" }))).toMatchObject({
      kind: "user.task",
      message: "Open example.com",
      accent: "task",
    })
    expect(
      toRunLogItem(
        event("agent.step.completed", {
          decision: { type: "browser_actions", thought: "Need page title.", actions: [] },
        }),
      ),
    ).toMatchObject({ kind: "reasoning", message: "Need page title.", accent: "reasoning" })
    expect(
      toRunLogItem(
        event("browser.tool.completed", {
          toolCall: { id: "tool_1", type: "navigate", url: "https://example.com" },
          result: { ok: true, message: "navigated" },
        }),
      ),
    ).toMatchObject({ kind: "tool.result", message: "navigate ok navigated", accent: "tool" })
    expect(toRunLogItem(event("run.completed", { finalAnswer: "Example Domain" }))).toMatchObject({
      kind: "agent.answer",
      message: "Example Domain",
      accent: "answer",
    })
  })
})

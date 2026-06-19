import { describe, expect, it } from "bun:test"
import type { RunEvent } from "@open-web-agent/core"
import { ReplayActionLogSchema, createReplayActionLog } from "./replay-log"

function event(type: RunEvent["type"], payload: Record<string, unknown>, sequence: number): RunEvent {
  return {
    id: `evt_${sequence}`,
    runId: "run_1",
    sessionId: "ses_1",
    stepId: null,
    sequence,
    type,
    payload,
    createdAt: "2026-06-17T00:00:00.000Z",
  }
}

describe("createReplayActionLog", () => {
  it("converts run events into a deterministic replay action log", () => {
    const log = createReplayActionLog({
      taskId: "example-domain-title",
      combo: { agentId: "simple-react-agent", modelId: "openrouter", environmentId: "playwright-browser" },
      events: [
        event(
          "browser.tool.completed",
          {
            toolCall: { id: "tool_1", type: "navigate", url: "https://example.com" },
            result: {
              ok: true,
              message: "navigated",
              observation: {
                url: "https://example.com/",
                title: "Example Domain",
                text: "Example Domain",
                screenshotPath: "/tmp/run/screenshots/step-0001.png",
                interactiveElements: [],
                metadata: {},
              },
              metadata: { latencyMs: 12 },
            },
          },
          3,
        ),
        event("model.completed", { response: { latencyMs: 25, usage: { inputTokens: 3, outputTokens: 2 }, costUsd: 0.001 } }, 4),
        event("run.completed", { finalAnswer: '페이지 제목은 "Example Domain"입니다.' }, 5),
      ],
    })

    expect(log).toEqual({
      version: 1,
      taskId: "example-domain-title",
      combo: { agentId: "simple-react-agent", modelId: "openrouter", environmentId: "playwright-browser" },
      entries: [
        {
          sequence: 3,
          type: "browser.tool",
          toolCall: { id: "tool_1", type: "navigate", url: "https://example.com" },
          result: {
            ok: true,
            message: "navigated",
            observation: { url: "https://example.com/", title: "Example Domain", text: "Example Domain" },
            metadata: { latencyMs: 12 },
          },
          latencyMs: 12,
        },
        {
          sequence: 4,
          type: "model",
          latencyMs: 25,
          inputTokens: 3,
          outputTokens: 2,
          costUsd: 0.001,
        },
        {
          sequence: 5,
          type: "run.completed",
          finalAnswer: '페이지 제목은 "Example Domain"입니다.',
        },
      ],
    })
    expect(ReplayActionLogSchema.parse(log)).toEqual(log)
  })
})

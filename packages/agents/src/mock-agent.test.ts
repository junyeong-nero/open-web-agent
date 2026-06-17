import { describe, expect, it } from "bun:test"
import type { AgentState, RuntimeContext } from "@open-web-agent/core"
import { EventBus } from "@open-web-agent/core"
import { MockAgent } from "./mock-agent"

function state(stepCount: number): AgentState {
  return {
    session: {
      id: "ses_1",
      projectPath: "/tmp/project",
      projectHash: "hash",
      createdAt: "2026-06-17T00:00:00.000Z",
    },
    runId: "run_1",
    prompt: "example.com에 접속해서 페이지 제목을 알려줘",
    steps: Array.from({ length: stepCount }, (_, index) => ({
      id: `step_${index}`,
      decision: null,
      observation: null,
      actionResults: [],
    })),
    lastObservation: null,
    finalAnswer: null,
  }
}

const ctx: RuntimeContext = {
  session: state(0).session,
  runId: "run_1",
  runDir: "/tmp/run",
  eventBus: new EventBus(),
  abortSignal: new AbortController().signal,
  now: () => new Date("2026-06-17T00:00:00.000Z"),
  async emit() {
    throw new Error("not used")
  },
}

describe("MockAgent", () => {
  it("returns browser actions for the first step", async () => {
    const decision = await new MockAgent().step(state(0), ctx)

    expect(decision.type).toBe("browser_actions")
    if (decision.type === "browser_actions") {
      expect(decision.actions[0]?.toolCalls.map((call) => call.type)).toEqual(["navigate", "screenshot", "extract_text"])
    }
  })

  it("returns the deterministic final answer after the first step", async () => {
    const decision = await new MockAgent().step(state(1), ctx)

    expect(decision).toEqual({
      type: "final_answer",
      thought: "The mock observation contains the deterministic title.",
      finalAnswer: '페이지 제목은 "Example Domain"입니다.',
      confidence: 1,
    })
  })
})

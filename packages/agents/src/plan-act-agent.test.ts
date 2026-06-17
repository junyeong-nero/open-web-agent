import { describe, expect, it } from "bun:test"
import { EventBus, type AgentState, type ModelPlugin, type ModelRequest, type ModelResponse, type RunEvent, type RuntimeContext } from "@open-web-agent/core"
import { PlanActAgent } from "./plan-act-agent"

function state(): AgentState {
  return {
    session: { id: "ses_1", projectPath: "/tmp/project", projectHash: "hash", createdAt: "2026-06-17T00:00:00.000Z" },
    runId: "run_1",
    prompt: "Read the title",
    steps: [],
    lastObservation: { url: "about:blank", title: null, text: null, screenshotPath: null, interactiveElements: [], metadata: {} },
    finalAnswer: null,
  }
}

class FakeModel implements ModelPlugin {
  id = "fake"
  name = "Fake"
  provider = "test"
  requests: ModelRequest[] = []

  constructor(private readonly responses: string[]) {}

  async complete(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(request)
    return { id: null, text: this.responses.shift() ?? "", raw: {}, usage: null, latencyMs: 0 }
  }
}

describe("PlanActAgent", () => {
  it("emits plan.created before choosing an action", async () => {
    const model = new FakeModel([
      JSON.stringify({ items: [{ id: "plan_1", title: "Open page", status: "pending" }] }),
      JSON.stringify({ type: "final_answer", thought: null, finalAnswer: "done", confidence: 1 }),
    ])
    const events: RunEvent[] = []
    const eventBus = new EventBus()
    eventBus.subscribe((event) => {
      events.push(event)
    })
    let sequence = 0
    const ctx: RuntimeContext = {
      session: state().session,
      runId: "run_1",
      runDir: "/tmp/run",
      eventBus,
      abortSignal: new AbortController().signal,
      now: () => new Date("2026-06-17T00:00:00.000Z"),
      async emit(type, payload, stepId = null) {
        const event: RunEvent = {
          id: `evt_${sequence}`,
          runId: "run_1",
          sessionId: "ses_1",
          stepId,
          sequence: sequence++,
          type,
          payload,
          createdAt: "2026-06-17T00:00:00.000Z",
        }
        await eventBus.publish(event)
        return event
      },
    }

    const decision = await new PlanActAgent({ model, modelName: "fake" }).step(state(), ctx)

    expect(events[0]?.type).toBe("plan.created")
    expect(events[0]?.payload.items).toEqual([{ id: "plan_1", title: "Open page", status: "pending" }])
    expect(decision).toMatchObject({ type: "final_answer", finalAnswer: "done" })
  })

  it("emits plan.updated after a failed browser action result", async () => {
    const model = new FakeModel([
      JSON.stringify({ items: [{ id: "plan_1", title: "Retry with a better target", status: "active" }] }),
      JSON.stringify({ type: "final_answer", thought: null, finalAnswer: "done", confidence: 1 }),
    ])
    const events: RunEvent[] = []
    const eventBus = new EventBus()
    eventBus.subscribe((event) => {
      events.push(event)
    })
    let sequence = 0
    const ctx: RuntimeContext = {
      session: state().session,
      runId: "run_1",
      runDir: "/tmp/run",
      eventBus,
      abortSignal: new AbortController().signal,
      now: () => new Date("2026-06-17T00:00:00.000Z"),
      async emit(type, payload, stepId = null) {
        const event: RunEvent = {
          id: `evt_${sequence}`,
          runId: "run_1",
          sessionId: "ses_1",
          stepId,
          sequence: sequence++,
          type,
          payload,
          createdAt: "2026-06-17T00:00:00.000Z",
        }
        await eventBus.publish(event)
        return event
      },
    }
    const failedState = state()
    failedState.steps.push({
      id: "step_1",
      decision: null,
      observation: failedState.lastObservation,
      actionResults: [{ ok: false, message: "No click target provided", observation: failedState.lastObservation, metadata: {} }],
    })

    const decision = await new PlanActAgent({ model, modelName: "fake" }).step(failedState, ctx)

    expect(events[0]?.type).toBe("plan.updated")
    expect(events[0]?.payload).toEqual({
      items: [{ id: "plan_1", title: "Retry with a better target", status: "active" }],
      reason: "browser_action_failed",
    })
    expect(decision).toMatchObject({ type: "final_answer", finalAnswer: "done" })
  })
})

import { describe, expect, it } from "bun:test"
import { RunEventSchema } from "./event"

describe("RunEventSchema", () => {
  it("accepts a valid run event", () => {
    const parsed = RunEventSchema.parse({
      id: "evt_1",
      runId: "run_1",
      sessionId: "ses_1",
      stepId: null,
      sequence: 0,
      type: "run.started",
      payload: {},
      createdAt: "2026-06-17T00:00:00.000Z",
    })

    expect(parsed.type).toBe("run.started")
  })

  it("rejects an unknown event type", () => {
    expect(() =>
      RunEventSchema.parse({
        id: "evt_1",
        runId: "run_1",
        sessionId: "ses_1",
        stepId: null,
        sequence: 0,
        type: "run.unknown",
        payload: {},
        createdAt: "2026-06-17T00:00:00.000Z",
      }),
    ).toThrow()
  })

  it("accepts plan events", () => {
    expect(
      RunEventSchema.parse({
        id: "evt_1",
        runId: "run_1",
        sessionId: "ses_1",
        stepId: null,
        sequence: 0,
        type: "plan.created",
        payload: { items: [] },
        createdAt: "2026-06-17T00:00:00.000Z",
      }).type,
    ).toBe("plan.created")
  })
})

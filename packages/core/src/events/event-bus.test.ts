import { describe, expect, it } from "bun:test"
import type { RunEvent } from "../contracts/event"
import { EventBus } from "./event-bus"

function event(sequence: number, type: RunEvent["type"] = "run.started"): RunEvent {
  return {
    id: `evt_${sequence}`,
    runId: "run_1",
    sessionId: "ses_1",
    stepId: null,
    sequence,
    type,
    payload: {},
    createdAt: "2026-06-17T00:00:00.000Z",
  }
}

describe("EventBus", () => {
  it("publishes events to multiple subscribers in order", async () => {
    const bus = new EventBus()
    const observed: string[] = []

    bus.subscribe(async (runEvent) => {
      observed.push(`a:${runEvent.sequence}`)
    })
    bus.subscribe((runEvent) => {
      observed.push(`b:${runEvent.sequence}`)
    })

    await bus.publish(event(0))
    await bus.publish(event(1, "run.completed"))

    expect(observed).toEqual(["a:0", "b:0", "a:1", "b:1"])
  })

  it("unsubscribe stops future delivery", async () => {
    const bus = new EventBus()
    const observed: number[] = []
    const unsubscribe = bus.subscribe((runEvent) => {
      observed.push(runEvent.sequence)
    })

    await bus.publish(event(0))
    unsubscribe()
    await bus.publish(event(1))

    expect(observed).toEqual([0])
  })
})

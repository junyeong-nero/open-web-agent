import { describe, expect, it } from "bun:test"
import type { RunEvent } from "../contracts/event"
import { EventBus } from "./event-bus"

function event(sequence: number, type: RunEvent["type"] = "run.started", runId = "run_1"): RunEvent {
  return {
    id: `evt_${sequence}`,
    runId,
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

  it("does not duplicate delivery when the same handler subscribes twice", async () => {
    const bus = new EventBus()
    const observed: number[] = []
    const handler = (runEvent: RunEvent) => {
      observed.push(runEvent.sequence)
    }

    bus.subscribe(handler)
    bus.subscribe(handler)
    await bus.publish(event(0))

    expect(observed).toEqual([0])
  })

  it("isolates subscriber failures from publishers and other subscribers", async () => {
    const bus = new EventBus()
    const observed: string[] = []

    bus.subscribe(() => {
      observed.push("before")
    })
    bus.subscribe(() => {
      throw new Error("broken subscriber")
    })
    bus.subscribe(async () => {
      throw new Error("rejected subscriber")
    })
    bus.subscribe(() => {
      observed.push("after")
    })

    await expect(bus.publish(event(0))).resolves.toBeUndefined()

    expect(observed).toEqual(["before", "after"])
  })

  it("dispatches subscribers concurrently for the same event", async () => {
    const bus = new EventBus()
    const observed: string[] = []
    let releaseSlowSubscriber: () => void = () => {}
    let resolveSlowSubscriberStarted: () => void = () => {}
    const slowSubscriberStarted = new Promise<void>((resolve) => {
      resolveSlowSubscriberStarted = resolve
    })
    const slowSubscriberRelease = new Promise<void>((resolve) => {
      releaseSlowSubscriber = resolve
    })

    bus.subscribe(async () => {
      resolveSlowSubscriberStarted()
      await slowSubscriberRelease
      observed.push("slow")
    })
    bus.subscribe(() => {
      observed.push("fast")
    })

    const published = bus.publish(event(0))
    await slowSubscriberStarted
    await Promise.resolve()

    expect(observed).toEqual(["fast"])

    releaseSlowSubscriber()
    await published

    expect(observed).toEqual(["fast", "slow"])
  })

  it("preserves subscriber order across non-awaited publishes", async () => {
    const bus = new EventBus()
    const observed: number[] = []
    let releaseFirstEvent: () => void = () => {}
    let resolveFirstEventStarted: () => void = () => {}
    const firstEventStarted = new Promise<void>((resolve) => {
      resolveFirstEventStarted = resolve
    })
    const firstEventRelease = new Promise<void>((resolve) => {
      releaseFirstEvent = resolve
    })

    bus.subscribe(async (runEvent) => {
      if (runEvent.sequence === 0) {
        resolveFirstEventStarted()
        await firstEventRelease
      }
      observed.push(runEvent.sequence)
    })

    const firstPublished = bus.publish(event(0))
    await firstEventStarted
    const secondPublished = bus.publish(event(1))

    expect(observed).toEqual([])

    releaseFirstEvent()
    await Promise.all([firstPublished, secondPublished])

    expect(observed).toEqual([0, 1])
  })

  it("dispatches events from different runs concurrently to the same subscriber", async () => {
    const bus = new EventBus()
    const observed: string[] = []
    let releaseFirstRun: () => void = () => {}
    let resolveFirstRunStarted: () => void = () => {}
    const firstRunStarted = new Promise<void>((resolve) => {
      resolveFirstRunStarted = resolve
    })
    const firstRunRelease = new Promise<void>((resolve) => {
      releaseFirstRun = resolve
    })

    bus.subscribe(async (runEvent) => {
      if (runEvent.runId === "run_1") {
        resolveFirstRunStarted()
        await firstRunRelease
      }
      observed.push(runEvent.runId)
    })

    const firstRunPublished = bus.publish(event(0, "run.started", "run_1"))
    await firstRunStarted
    await bus.publish(event(0, "run.started", "run_2"))

    expect(observed).toEqual(["run_2"])

    releaseFirstRun()
    await firstRunPublished

    expect(observed).toEqual(["run_2", "run_1"])
  })
})

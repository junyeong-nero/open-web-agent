import type { RunEvent } from "../contracts/event"

export type EventHandler = (event: RunEvent) => void | Promise<void>

interface EventSubscriber {
  handler: EventHandler
  pendingByRun: Map<string, Promise<void>>
}

export class EventBus {
  private subscribers = new Map<EventHandler, EventSubscriber>()

  subscribe(handler: EventHandler): () => void {
    if (!this.subscribers.has(handler)) {
      this.subscribers.set(handler, {
        handler,
        pendingByRun: new Map(),
      })
    }

    return () => {
      this.subscribers.delete(handler)
    }
  }

  async publish(event: RunEvent): Promise<void> {
    await Promise.all(
      [...this.subscribers.values()].map((subscriber) => {
        const deliver = async (): Promise<void> => {
          try {
            await subscriber.handler(event)
          } catch {
            // Subscribers are best-effort observers. A broken stream or logger must
            // not fail the run that produced the event.
          }
        }

        const previous = subscriber.pendingByRun.get(event.runId)
        const delivery = previous ? previous.then(deliver) : deliver()
        subscriber.pendingByRun.set(event.runId, delivery)
        void delivery.then(() => {
          if (subscriber.pendingByRun.get(event.runId) === delivery) {
            subscriber.pendingByRun.delete(event.runId)
          }
        })
        return delivery
      }),
    )
  }
}

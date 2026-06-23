import type { RunEvent } from "../contracts/event"

export type EventHandler = (event: RunEvent) => void | Promise<void>

export class EventBus {
  private handlers = new Set<EventHandler>()

  subscribe(handler: EventHandler): () => void {
    this.handlers.add(handler)
    return () => {
      this.handlers.delete(handler)
    }
  }

  async publish(event: RunEvent): Promise<void> {
    await Promise.all(
      [...this.handlers].map(async (handler) => {
        try {
          await handler(event)
        } catch {
          // Subscribers are best-effort observers. A broken stream or logger must
          // not fail the run that produced the event.
        }
      }),
    )
  }
}

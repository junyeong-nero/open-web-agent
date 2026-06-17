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
    for (const handler of [...this.handlers]) {
      await handler(event)
    }
  }
}

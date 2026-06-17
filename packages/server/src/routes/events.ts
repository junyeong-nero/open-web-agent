import type { Hono } from "hono"
import { streamSSE } from "hono/streaming"
import type { EventBus } from "@open-web-agent/core"

export interface EventRouteDeps {
  eventBus: EventBus
}

export function registerEventRoutes(app: Hono, deps: EventRouteDeps): void {
  app.get("/events", (c) =>
    streamSSE(c, async (stream) => {
      const unsubscribe = deps.eventBus.subscribe((event) =>
        stream.writeSSE({
          event: event.type,
          id: String(event.sequence),
          data: JSON.stringify(event),
        }),
      )

      stream.onAbort(unsubscribe)

      while (!stream.aborted && !stream.closed) {
        await stream.sleep(1000)
      }

      unsubscribe()
    }),
  )
}

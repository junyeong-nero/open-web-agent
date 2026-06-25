import type { Hono } from "hono"
import { streamSSE } from "hono/streaming"
import type { EventBus } from "@open-web-agent/core"

export interface EventRouteDeps {
  eventBus: EventBus
}

export function registerEventRoutes(app: Hono, deps: EventRouteDeps): void {
  app.get("/events", (c) =>
    streamSSE(c, async (stream) => {
      let unsubscribe: () => void = () => {}
      unsubscribe = deps.eventBus.subscribe(async (event) => {
        try {
          await stream.writeSSE({
            event: event.type,
            id: String(event.sequence),
            data: JSON.stringify(event),
          })
        } catch {
          unsubscribe()
        }
      })

      stream.onAbort(unsubscribe)
      await stream.write(": connected\n\n")

      while (!stream.aborted && !stream.closed) {
        await stream.sleep(1000)
      }

      unsubscribe()
    }),
  )
}

import type { Hono } from "hono"

export function registerHealthRoutes(app: Hono): void {
  app.get("/health", (c) => c.json({ ok: true }))
}

import type { Hono } from "hono"
import { CreateRunRequestSchema } from "../schemas/api"
import { isHttpError, submitRun, type SubmitRunDeps } from "../run-submission"
import { readJsonBody } from "./json-body"

export type { RunRecord } from "../run-submission"

export interface RunRouteDeps extends SubmitRunDeps {}

export function registerRunRoutes(app: Hono, deps: RunRouteDeps): void {
  app.post("/runs", async (c) => {
    const body = await readJsonBody(c.req)
    if (!body.ok) return c.json({ error: body.error }, body.status)
    const parsed = CreateRunRequestSchema.safeParse(body.value)
    if (!parsed.success) return c.json({ error: "Invalid run request" }, 400)

    try {
      return c.json(await submitRun(deps, parsed.data))
    } catch (error) {
      if (isHttpError(error)) return c.json({ error: error.message }, error.status)
      throw error
    }
  })

  app.get("/runs/:runId", (c) => {
    const run = deps.runs.get(c.req.param("runId"))
    if (!run) return c.json({ error: "Unknown run" }, 404)

    return c.json(run)
  })

  app.post("/runs/:runId/cancel", (c) => {
    return c.json({ cancelled: deps.orchestrator.cancelRun(c.req.param("runId")) })
  })
}

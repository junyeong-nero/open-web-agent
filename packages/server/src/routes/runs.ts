import type { Hono } from "hono"
import type { RunOrchestrator, RunResult, SessionState } from "@open-web-agent/core"
import { CreateRunRequestSchema } from "../schemas/api"

export interface RunRecord {
  runId: string
  status: "running" | RunResult["status"]
  finalAnswer: string | null
}

export interface RunRouteDeps {
  orchestrator: RunOrchestrator
  sessions: Map<string, SessionState>
  runs: Map<string, RunRecord>
}

export function registerRunRoutes(app: Hono, deps: RunRouteDeps): void {
  app.post("/runs", async (c) => {
    const parsed = CreateRunRequestSchema.safeParse(await readJson(c.req))
    if (!parsed.success) return c.json({ error: "Invalid run request" }, 400)

    const session = deps.sessions.get(parsed.data.sessionId)
    if (!session) return c.json({ error: "Unknown session" }, 404)

    const started = deps.orchestrator.startRun({ session, prompt: parsed.data.prompt })
    deps.runs.set(started.runId, { runId: started.runId, status: "running", finalAnswer: null })
    void started.result
      .then((result) => {
        deps.runs.set(started.runId, {
          runId: started.runId,
          status: result.status,
          finalAnswer: result.finalAnswer,
        })
      })
      .catch((error) => {
        deps.runs.set(started.runId, {
          runId: started.runId,
          status: "failed",
          finalAnswer: error instanceof Error ? error.message : String(error),
        })
      })

    return c.json({ runId: started.runId })
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

async function readJson(request: { json(): Promise<unknown> }): Promise<unknown> {
  return request.json().catch(() => null)
}

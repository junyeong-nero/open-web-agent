import type { Hono } from "hono"
import type { PluginRegistry, RunOrchestrator, RunResult, SessionState } from "@open-web-agent/core"
import { randomUUID } from "node:crypto"
import type { SQLiteStore } from "@open-web-agent/storage"
import { CreateRunRequestSchema } from "../schemas/api"

export interface RunRecord {
  runId: string
  status: "running" | RunResult["status"]
  finalAnswer: string | null
}

export interface RunRouteDeps {
  orchestrator: RunOrchestrator
  registry: PluginRegistry
  sessions: Map<string, SessionState>
  runs: Map<string, RunRecord>
  storage?: SQLiteStore
}

export function registerRunRoutes(app: Hono, deps: RunRouteDeps): void {
  app.post("/runs", async (c) => {
    const parsed = CreateRunRequestSchema.safeParse(await readJson(c.req))
    if (!parsed.success) return c.json({ error: "Invalid run request" }, 400)

    const session = deps.sessions.get(parsed.data.sessionId)
    if (!session) return c.json({ error: "Unknown session" }, 404)

    if (parsed.data.agentId && !deps.registry.listAgents().some((agent) => agent.id === parsed.data.agentId)) {
      return c.json({ error: "Unknown agent" }, 400)
    }
    if (parsed.data.modelId && !deps.registry.listModels().some((model) => model.id === parsed.data.modelId)) {
      return c.json({ error: "Unknown model" }, 400)
    }
    if (
      parsed.data.environmentId &&
      !deps.registry.listEnvironments().some((environment) => environment.id === parsed.data.environmentId)
    ) {
      return c.json({ error: "Unknown browser" }, 400)
    }

    const started = deps.orchestrator.startRun({
      session,
      prompt: parsed.data.prompt,
      agentId: parsed.data.agentId,
      modelId: parsed.data.modelId,
      environmentId: parsed.data.environmentId,
    })
    deps.runs.set(started.runId, { runId: started.runId, status: "running", finalAnswer: null })
    const createdAt = new Date().toISOString()
    deps.storage?.upsertRun({
      id: started.runId,
      sessionId: session.id,
      status: "running",
      finalAnswer: null,
      createdAt,
      updatedAt: createdAt,
    })
    deps.storage?.appendMessage({
      id: `msg_${randomUUID().replaceAll("-", "")}`,
      sessionId: session.id,
      role: "user",
      content: parsed.data.prompt,
      createdAt,
    })
    void started.result
      .then((result) => {
        const updatedAt = new Date().toISOString()
        deps.runs.set(started.runId, {
          runId: started.runId,
          status: result.status,
          finalAnswer: result.finalAnswer,
        })
        deps.storage?.upsertRun({
          id: started.runId,
          sessionId: session.id,
          status: result.status,
          finalAnswer: result.finalAnswer,
          createdAt,
          updatedAt,
        })
        if (result.finalAnswer) {
          deps.storage?.appendMessage({
            id: `msg_${randomUUID().replaceAll("-", "")}`,
            sessionId: session.id,
            role: "assistant",
            content: result.finalAnswer,
            createdAt: updatedAt,
          })
        }
      })
      .catch((error) => {
        const updatedAt = new Date().toISOString()
        const message = error instanceof Error ? error.message : String(error)
        deps.runs.set(started.runId, {
          runId: started.runId,
          status: "failed",
          finalAnswer: message,
        })
        deps.storage?.upsertRun({
          id: started.runId,
          sessionId: session.id,
          status: "failed",
          finalAnswer: message,
          createdAt,
          updatedAt,
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

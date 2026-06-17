import type { Hono } from "hono"
import type { PluginRegistry, RunOrchestrator, RunResult, SessionState } from "@open-web-agent/core"
import { randomUUID } from "node:crypto"
import type { SQLiteStore } from "@open-web-agent/storage"
import { CreateRunRequestSchema } from "../schemas/api"
import type { BrowserSessionManager } from "../browser-session-manager"

export interface RunRecord {
  runId: string
  sessionId: string
  status: "running" | RunResult["status"]
  finalAnswer: string | null
}

export interface RunRouteDeps {
  orchestrator: RunOrchestrator
  registry: PluginRegistry
  sessions: Map<string, SessionState>
  runs: Map<string, RunRecord>
  storage?: SQLiteStore
  browserSessions: BrowserSessionManager
}

export function registerRunRoutes(app: Hono, deps: RunRouteDeps): void {
  app.post("/runs", async (c) => {
    const parsed = CreateRunRequestSchema.safeParse(await readJson(c.req))
    if (!parsed.success) return c.json({ error: "Invalid run request" }, 400)

    const session = deps.sessions.get(parsed.data.sessionId) ?? deps.storage?.getSession(parsed.data.sessionId)
    if (!session || session.deletedAt) return c.json({ error: "Unknown session" }, 404)
    deps.sessions.set(session.id, session)

    if (parsed.data.agentId && !deps.registry.listAgents().some((agent) => agent.id === parsed.data.agentId)) {
      return c.json({ error: "Unknown agent" }, 400)
    }
    if (parsed.data.modelId && !deps.registry.listModels().some((model) => model.id === parsed.data.modelId)) {
      return c.json({ error: "Unknown model" }, 400)
    }
    const environmentId = parsed.data.environmentId ?? session.environmentId ?? deps.browserSessions.defaultEnvironmentId
    if (!deps.registry.listEnvironments().some((environment) => environment.id === environmentId)) {
      return c.json({ error: "Unknown browser" }, 400)
    }

    const runSession: SessionState =
      session.environmentId === environmentId ? session : { ...session, environmentId }
    if (runSession !== session) {
      deps.sessions.set(runSession.id, runSession)
      deps.storage?.upsertSession({
        id: runSession.id,
        projectPath: runSession.projectPath,
        projectHash: runSession.projectHash,
        environmentId: runSession.environmentId ?? null,
        title: runSession.title ?? null,
        pinned: runSession.pinned ?? false,
        deletedAt: runSession.deletedAt ?? null,
        createdAt: runSession.createdAt,
      })
    }
    await deps.browserSessions.attach(runSession, environmentId)

    const started = deps.orchestrator.startRun({
      session: runSession,
      prompt: parsed.data.prompt,
      agentId: parsed.data.agentId,
      modelId: parsed.data.modelId,
      environmentId,
    })
    deps.runs.set(started.runId, { runId: started.runId, sessionId: runSession.id, status: "running", finalAnswer: null })
    const createdAt = new Date().toISOString()
    deps.storage?.upsertRun({
      id: started.runId,
      sessionId: runSession.id,
      status: "running",
      finalAnswer: null,
      createdAt,
      updatedAt: createdAt,
    })
    deps.storage?.appendMessage({
      id: `msg_${randomUUID().replaceAll("-", "")}`,
      sessionId: runSession.id,
      role: "user",
      content: parsed.data.prompt,
      createdAt,
    })
    void started.result
      .then(async (result) => {
        await deps.browserSessions.capture(runSession, environmentId).catch(() => null)
        const updatedAt = new Date().toISOString()
        deps.runs.set(started.runId, {
          runId: started.runId,
          sessionId: runSession.id,
          status: result.status,
          finalAnswer: result.finalAnswer,
        })
        deps.storage?.upsertRun({
          id: started.runId,
          sessionId: runSession.id,
          status: result.status,
          finalAnswer: result.finalAnswer,
          createdAt,
          updatedAt,
        })
        if (result.finalAnswer) {
          deps.storage?.appendMessage({
            id: `msg_${randomUUID().replaceAll("-", "")}`,
            sessionId: runSession.id,
            role: "assistant",
            content: result.finalAnswer,
            createdAt: updatedAt,
          })
        }
      })
      .catch(async (error) => {
        await deps.browserSessions.capture(runSession, environmentId).catch(() => null)
        const updatedAt = new Date().toISOString()
        const message = error instanceof Error ? error.message : String(error)
        deps.runs.set(started.runId, {
          runId: started.runId,
          sessionId: runSession.id,
          status: "failed",
          finalAnswer: message,
        })
        deps.storage?.upsertRun({
          id: started.runId,
          sessionId: runSession.id,
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

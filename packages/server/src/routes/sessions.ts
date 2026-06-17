import { resolve } from "node:path"
import type { Hono } from "hono"
import { hashProjectPath, makeSessionId, type SessionState } from "@open-web-agent/core"
import type { SQLiteStore, StoredSession } from "@open-web-agent/storage"
import type { RunRecord } from "./runs"
import { CreateSessionRequestSchema, UpdateSessionRequestSchema } from "../schemas/api"

export interface SessionRouteDeps {
  sessions: Map<string, SessionState>
  runs?: Map<string, RunRecord>
  storage?: SQLiteStore
  now?: () => Date
}

export function registerSessionRoutes(app: Hono, deps: SessionRouteDeps): void {
  app.get("/sessions", (c) => {
    const sessions = deps.storage?.listSessions() ?? [...deps.sessions.values()]
    return c.json({
      sessions: sessions.filter((session) => !session.deletedAt).map((session) => serializeSession(session, deps.runs)),
    })
  })

  app.post("/sessions", async (c) => {
    const parsed = CreateSessionRequestSchema.safeParse(await readJson(c.req))
    if (!parsed.success) return c.json({ error: "Invalid session request" }, 400)

    const projectPath = resolve(parsed.data.projectPath)
    const session: SessionState = {
      id: makeSessionId(),
      projectPath,
      projectHash: hashProjectPath(projectPath),
      title: parsed.data.title ?? null,
      pinned: false,
      deletedAt: null,
      createdAt: (deps.now ?? (() => new Date()))().toISOString(),
    }
    deps.sessions.set(session.id, session)
    deps.storage?.upsertSession(toStoredSession(session))

    return c.json({ sessionId: session.id, session: serializeSession(session, deps.runs) })
  })

  app.get("/sessions/:sessionId", (c) => {
    const sessionId = c.req.param("sessionId")
    const session = deps.sessions.get(sessionId) ?? deps.storage?.getSession(sessionId)
    if (!session || session.deletedAt) return c.json({ error: "Unknown session" }, 404)

    deps.sessions.set(session.id, session)
    return c.json(serializeSession(session, deps.runs))
  })

  app.patch("/sessions/:sessionId", async (c) => {
    const parsed = UpdateSessionRequestSchema.safeParse(await readJson(c.req))
    if (!parsed.success) return c.json({ error: "Invalid session request" }, 400)

    const sessionId = c.req.param("sessionId")
    const session = deps.sessions.get(sessionId) ?? deps.storage?.getSession(sessionId)
    if (!session || session.deletedAt) return c.json({ error: "Unknown session" }, 404)

    const next: SessionState = {
      ...session,
      title: parsed.data.title === undefined ? session.title ?? null : parsed.data.title,
      pinned: parsed.data.pinned === undefined ? session.pinned ?? false : parsed.data.pinned,
      deletedAt: null,
    }
    const stored = deps.storage?.updateSession(sessionId, { title: next.title ?? null, pinned: next.pinned ?? false }) ?? next
    deps.sessions.set(sessionId, stored)

    return c.json(serializeSession(stored, deps.runs))
  })

  app.delete("/sessions/:sessionId", (c) => {
    const sessionId = c.req.param("sessionId")
    const session = deps.sessions.get(sessionId) ?? deps.storage?.getSession(sessionId)
    if (!session || session.deletedAt) return c.json({ error: "Unknown session" }, 404)
    if (isSessionRunning(sessionId, deps.runs)) return c.json({ error: "Session has a running run" }, 409)

    const deletedAt = (deps.now ?? (() => new Date()))().toISOString()
    deps.sessions.delete(sessionId)
    deps.storage?.deleteSession(sessionId, deletedAt)

    return c.body(null, 204)
  })
}

function serializeSession(session: SessionState, runs?: Map<string, RunRecord>) {
  return {
    id: session.id,
    projectPath: session.projectPath,
    projectHash: session.projectHash,
    title: session.title ?? null,
    pinned: session.pinned ?? false,
    deletedAt: session.deletedAt ?? null,
    createdAt: session.createdAt,
    runStatus: readSessionRunStatus(session.id, runs),
  }
}

function toStoredSession(session: SessionState): StoredSession {
  return {
    id: session.id,
    projectPath: session.projectPath,
    projectHash: session.projectHash,
    title: session.title ?? null,
    pinned: session.pinned ?? false,
    deletedAt: session.deletedAt ?? null,
    createdAt: session.createdAt,
  }
}

function readSessionRunStatus(sessionId: string, runs?: Map<string, RunRecord>) {
  if (!runs) return "idle"
  for (const run of runs.values()) {
    if (run.sessionId === sessionId && run.status === "running") return "running"
  }
  return "idle"
}

function isSessionRunning(sessionId: string, runs?: Map<string, RunRecord>): boolean {
  return readSessionRunStatus(sessionId, runs) === "running"
}

async function readJson(request: { json(): Promise<unknown> }): Promise<unknown> {
  return request.json().catch(() => null)
}

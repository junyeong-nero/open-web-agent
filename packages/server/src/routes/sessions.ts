import { resolve } from "node:path"
import type { Hono } from "hono"
import { hashProjectPath, makeSessionId, type SessionState } from "@open-web-agent/core"
import type { SQLiteStore } from "@open-web-agent/storage"
import { CreateSessionRequestSchema } from "../schemas/api"

export interface SessionRouteDeps {
  sessions: Map<string, SessionState>
  storage?: SQLiteStore
  now?: () => Date
}

export function registerSessionRoutes(app: Hono, deps: SessionRouteDeps): void {
  app.get("/sessions", (c) => {
    const sessions = deps.storage?.listSessions() ?? [...deps.sessions.values()]
    return c.json({
      sessions: sessions.map((session) => ({
        id: session.id,
        projectPath: session.projectPath,
        projectHash: session.projectHash,
        createdAt: session.createdAt,
      })),
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
      createdAt: (deps.now ?? (() => new Date()))().toISOString(),
    }
    deps.sessions.set(session.id, session)
    deps.storage?.upsertSession(session)

    return c.json({ sessionId: session.id })
  })

  app.get("/sessions/:sessionId", (c) => {
    const sessionId = c.req.param("sessionId")
    const session = deps.sessions.get(sessionId) ?? deps.storage?.getSession(sessionId)
    if (!session) return c.json({ error: "Unknown session" }, 404)

    deps.sessions.set(session.id, session)
    return c.json(session)
  })
}

async function readJson(request: { json(): Promise<unknown> }): Promise<unknown> {
  return request.json().catch(() => null)
}

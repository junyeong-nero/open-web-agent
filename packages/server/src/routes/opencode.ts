import type { Hono } from "hono"
import type { EventBus, PluginRegistry, SessionState } from "@open-web-agent/core"
import {
  projectAgents,
  projectMessages,
  projectProviderConfig,
  projectProviderList,
  projectSession,
} from "@open-web-agent/opencode-compat"
import type { SQLiteStore } from "@open-web-agent/storage"
import type { RunRecord } from "./runs"

export interface OpenCodeRouteDeps {
  eventBus: EventBus
  registry: PluginRegistry
  sessions: Map<string, SessionState>
  runs: Map<string, RunRecord>
  storage?: SQLiteStore
  defaults?: {
    agentId?: string | null
    modelId?: string | null
    environmentId?: string | null
    browserHeadless?: boolean | null
  }
}

export function registerOpenCodeRoutes(app: Hono, deps: OpenCodeRouteDeps): void {
  app.get("/opencode/global/health", (c) => c.json({ ok: true }))
  app.get("/opencode/config", (c) => c.json({}))
  app.get("/opencode/config/providers", (c) =>
    c.json(projectProviderConfig(deps.registry.listModels(), deps.defaults?.modelId)),
  )
  app.get("/opencode/provider", (c) => c.json(projectProviderList(deps.registry.listModels(), deps.defaults?.modelId)))
  app.get("/opencode/provider/auth", (c) => c.json({}))
  app.get("/opencode/agent", (c) => c.json(projectAgents(deps.registry.listAgents(), deps.defaults?.agentId)))

  app.get("/opencode/command", (c) => c.json([]))
  app.get("/opencode/lsp", (c) => c.json([]))
  app.get("/opencode/mcp", (c) => c.json({}))
  app.get("/opencode/mcp/resource", (c) => c.json({}))
  app.get("/opencode/formatter", (c) => c.json([]))
  app.get("/opencode/vcs", (c) => c.json(null))
  app.get("/opencode/experimental/capabilities", (c) => c.json({ backgroundSubagents: false }))
  app.get("/opencode/experimental/console", (c) => c.json({ consoleManagedProviders: [], switchableOrgCount: 0 }))

  app.get("/opencode/session", (c) =>
    c.json(listSessions(deps).map((session) => projectSession(session, readDefaults(deps)))),
  )
  app.get("/opencode/session/status", (c) => c.json(readSessionStatuses(deps.runs)))
  app.get("/opencode/session/:sessionId", (c) => {
    const session = findSession(deps, c.req.param("sessionId"))
    if (!session) return c.json({ error: { message: "Unknown session" } }, 404)
    return c.json(projectSession(session, readDefaults(deps)))
  })
  app.get("/opencode/session/:sessionId/message", (c) => {
    const session = findSession(deps, c.req.param("sessionId"))
    if (!session) return c.json({ error: { message: "Unknown session" } }, 404)
    return c.json(projectMessages(session, deps.storage?.listMessages(session.id) ?? [], readDefaults(deps)))
  })
  app.get("/opencode/session/:sessionId/todo", (c) => {
    if (!findSession(deps, c.req.param("sessionId"))) return c.json({ error: { message: "Unknown session" } }, 404)
    return c.json([])
  })
  app.get("/opencode/session/:sessionId/diff", (c) => {
    if (!findSession(deps, c.req.param("sessionId"))) return c.json({ error: { message: "Unknown session" } }, 404)
    return c.json([])
  })
}

function readDefaults(deps: OpenCodeRouteDeps) {
  return {
    defaultAgentId: deps.defaults?.agentId,
    defaultModelId: deps.defaults?.modelId,
  }
}

function listSessions(deps: OpenCodeRouteDeps) {
  return deps.storage?.listSessions() ?? [...deps.sessions.values()].filter((session) => !session.deletedAt)
}

function findSession(deps: OpenCodeRouteDeps, sessionId: string) {
  const session = deps.sessions.get(sessionId) ?? deps.storage?.getSession(sessionId) ?? null
  return isDeletedSession(session) ? null : session
}

function isDeletedSession(session: { deletedAt?: string | null } | null): boolean {
  return Boolean(session?.deletedAt)
}

function readSessionStatuses(runs: Map<string, RunRecord>) {
  const statuses: Record<string, { type: "busy" | "idle" }> = {}
  for (const run of runs.values()) {
    if (run.status === "running") statuses[run.sessionId] = { type: "busy" }
  }
  return statuses
}

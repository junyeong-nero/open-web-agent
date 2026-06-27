import { resolve } from "node:path"
import type { Hono } from "hono"
import { hashProjectPath, makeSessionId, type EventBus, type PluginRegistry, type RunOrchestrator, type SessionState } from "@open-web-agent/core"
import {
  projectAgents,
  projectMessages,
  projectProviderConfig,
  projectProviderList,
  projectSession,
  resolveModelId,
  type OpenCodeModelSelection,
} from "@open-web-agent/opencode-compat"
import type { SQLiteStore, StoredMessage } from "@open-web-agent/storage"
import type { BrowserSessionManager } from "../browser-session-manager"
import { isHttpError, submitRun } from "../run-submission"
import type { RunRecord } from "./runs"
import { readJsonBody } from "./json-body"

export interface OpenCodeRouteDeps {
  eventBus: EventBus
  orchestrator: RunOrchestrator
  registry: PluginRegistry
  sessions: Map<string, SessionState>
  runs: Map<string, RunRecord>
  messages?: Map<string, StoredMessage[]>
  storage?: SQLiteStore
  browserSessions: BrowserSessionManager
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
  app.post("/opencode/session", async (c) => {
    const body = await readJsonBody(c.req)
    if (!body.ok) return c.json({ error: { message: body.error } }, body.status)
    const input = isRecord(body.value) ? body.value : {}
    const directory = resolve(c.req.query("directory") ?? process.cwd())
    const environmentId = deps.defaults?.environmentId ?? deps.browserSessions.defaultEnvironmentId
    if (!deps.registry.listEnvironments().some((environment) => environment.id === environmentId)) {
      return c.json({ error: { message: "Unknown browser" } }, 400)
    }
    const session: SessionState = {
      id: makeSessionId(),
      projectPath: directory,
      projectHash: hashProjectPath(directory),
      environmentId,
      title: typeof input.title === "string" ? input.title : null,
      pinned: false,
      deletedAt: null,
      createdAt: new Date().toISOString(),
    }
    await deps.browserSessions.open(session, environmentId)
    deps.sessions.set(session.id, session)
    deps.storage?.upsertSession({
      id: session.id,
      projectPath: session.projectPath,
      projectHash: session.projectHash,
      environmentId: session.environmentId ?? null,
      title: session.title ?? null,
      pinned: false,
      deletedAt: null,
      createdAt: session.createdAt,
    })
    return c.json(projectSession(session, readDefaults(deps)))
  })
  app.get("/opencode/session/status", (c) => c.json(readSessionStatuses(deps.runs)))
  app.get("/opencode/session/:sessionId", (c) => {
    const session = findSession(deps, c.req.param("sessionId"))
    if (!session) return c.json({ error: { message: "Unknown session" } }, 404)
    return c.json(projectSession(session, readDefaults(deps)))
  })
  app.get("/opencode/session/:sessionId/message", (c) => {
    const session = findSession(deps, c.req.param("sessionId"))
    if (!session) return c.json({ error: { message: "Unknown session" } }, 404)
    return c.json(projectMessages(session, listMessages(deps, session.id), readDefaults(deps)))
  })
  app.post("/opencode/session/:sessionId/message", async (c) => {
    const session = findSession(deps, c.req.param("sessionId"))
    if (!session) return c.json({ error: { message: "Unknown session" } }, 404)
    const body = await readJsonBody(c.req)
    if (!body.ok) return c.json({ error: { message: body.error } }, body.status)
    const input = isRecord(body.value) ? body.value : {}
    const prompt = readPrompt(input)
    if (!prompt) return c.json({ error: { message: "Prompt text is required" } }, 400)
    const modelId = resolveOpenCodeModelId(deps.registry.listModels(), input.model, deps.defaults?.modelId)
    if (modelId === null) return c.json({ error: { message: "Unknown model" } }, 400)
    try {
      await submitRun(deps, {
        sessionId: session.id,
        prompt,
        agentId: typeof input.agent === "string" ? input.agent : deps.defaults?.agentId ?? undefined,
        modelId,
        environmentId: session.environmentId ?? deps.defaults?.environmentId ?? undefined,
      })
      return c.json({ ok: true })
    } catch (error) {
      if (isHttpError(error)) return c.json({ error: { message: error.message } }, error.status)
      throw error
    }
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

function listMessages(deps: OpenCodeRouteDeps, sessionId: string): StoredMessage[] {
  return deps.storage?.listMessages(sessionId) ?? deps.messages?.get(sessionId) ?? []
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

function readPrompt(input: Record<string, unknown>): string {
  if (Array.isArray(input.parts)) {
    return input.parts
      .flatMap((part) => (isRecord(part) && part.type === "text" && typeof part.text === "string" ? [part.text] : []))
      .join("\n")
      .trim()
  }

  for (const key of ["text", "prompt", "message"]) {
    const value = input[key]
    if (typeof value === "string" && value.trim()) return value.trim()
  }

  return ""
}

function resolveOpenCodeModelId(
  models: ReturnType<PluginRegistry["listModels"]>,
  value: unknown,
  fallbackModelId?: string | null,
): string | null | undefined {
  const selection = readModelSelection(value)
  if (!selection) return resolveModelId(models, undefined, fallbackModelId)

  const requested = selection.modelID ?? selection.id
  return models.find((model) => model.provider === selection.providerID && model.id === requested)?.id ?? null
}

function readModelSelection(value: unknown): OpenCodeModelSelection | undefined {
  if (!isRecord(value) || typeof value.providerID !== "string") return undefined
  const modelID = typeof value.modelID === "string" ? value.modelID : undefined
  const id = typeof value.id === "string" ? value.id : undefined
  if (!modelID && !id) return undefined
  return {
    providerID: value.providerID,
    modelID,
    id,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

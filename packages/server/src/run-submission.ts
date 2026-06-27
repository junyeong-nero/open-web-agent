import { randomUUID } from "node:crypto"
import type { PluginRegistry, RunOrchestrator, RunResult, SessionState } from "@open-web-agent/core"
import type { SQLiteStore, StoredMessage } from "@open-web-agent/storage"
import type { BrowserSessionManager } from "./browser-session-manager"

export type HttpErrorStatus = 400 | 404 | 409

export interface RunRecord {
  runId: string
  sessionId: string
  status: "running" | RunResult["status"]
  finalAnswer: string | null
}

export interface SubmitRunDeps {
  orchestrator: RunOrchestrator
  registry: PluginRegistry
  sessions: Map<string, SessionState>
  runs: Map<string, RunRecord>
  messages?: Map<string, StoredMessage[]>
  storage?: SQLiteStore
  browserSessions: BrowserSessionManager
}

export interface SubmitRunInput {
  sessionId: string
  prompt: string
  agentId?: string
  modelId?: string
  environmentId?: string
}

export async function submitRun(deps: SubmitRunDeps, input: SubmitRunInput): Promise<{ runId: string }> {
  const session = deps.sessions.get(input.sessionId) ?? deps.storage?.getSession(input.sessionId)
  if (!session || session.deletedAt) throw httpError(404, "Unknown session")
  deps.sessions.set(session.id, session)
  if (hasRunningRun(session.id, deps.runs)) throw httpError(409, "Session has a running run")

  if (input.agentId && !deps.registry.listAgents().some((agent) => agent.id === input.agentId)) {
    throw httpError(400, "Unknown agent")
  }
  if (input.modelId && !deps.registry.listModels().some((model) => model.id === input.modelId)) {
    throw httpError(400, "Unknown model")
  }
  const environmentId = input.environmentId ?? session.environmentId ?? deps.browserSessions.defaultEnvironmentId
  if (!deps.registry.listEnvironments().some((environment) => environment.id === environmentId)) {
    throw httpError(400, "Unknown browser")
  }

  const runSession: SessionState = session.environmentId === environmentId ? session : { ...session, environmentId }
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
  const pendingRunId = `pending_${randomUUID().replaceAll("-", "")}`
  deps.runs.set(pendingRunId, { runId: pendingRunId, sessionId: runSession.id, status: "running", finalAnswer: null })

  let started: ReturnType<RunOrchestrator["startRun"]>
  try {
    await deps.browserSessions.attach(runSession, environmentId)
    started = deps.orchestrator.startRun({
      session: runSession,
      prompt: input.prompt,
      agentId: input.agentId,
      modelId: input.modelId,
      environmentId,
    })
  } catch (error) {
    deps.runs.delete(pendingRunId)
    throw error
  }
  deps.runs.delete(pendingRunId)
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
  appendMessage(deps, {
    id: makeMessageId(),
    sessionId: runSession.id,
    role: "user",
    content: input.prompt,
    createdAt,
  })
  void started.result
    .then((result) => {
      const updatedAt = new Date().toISOString()
      recordRunResult(deps, started.runId, runSession.id, result)
      persistRunBestEffort(deps, {
        id: started.runId,
        sessionId: runSession.id,
        status: result.status,
        finalAnswer: result.finalAnswer,
        createdAt,
        updatedAt,
      })
      if (result.finalAnswer) {
        appendMessageBestEffort(deps, {
          id: makeMessageId(),
          sessionId: runSession.id,
          role: "assistant",
          content: result.finalAnswer,
          createdAt: updatedAt,
        })
      }
      captureBestEffort(deps, runSession, environmentId)
    })
    .catch((error) => {
      const updatedAt = new Date().toISOString()
      const message = error instanceof Error ? error.message : String(error)
      recordRunFailure(deps, started.runId, runSession.id, message)
      persistRunBestEffort(deps, {
        id: started.runId,
        sessionId: runSession.id,
        status: "failed",
        finalAnswer: message,
        createdAt,
        updatedAt,
      })
      captureBestEffort(deps, runSession, environmentId)
    })

  return { runId: started.runId }
}

export function hasRunningRun(sessionId: string, runs: Map<string, RunRecord>): boolean {
  for (const run of runs.values()) {
    if (run.sessionId === sessionId && run.status === "running") return true
  }
  return false
}

export function httpError(status: HttpErrorStatus, message: string): Error & { status: HttpErrorStatus } {
  const error = new Error(message) as Error & { status: HttpErrorStatus }
  error.status = status
  return error
}

export function isHttpError(error: unknown): error is Error & { status: HttpErrorStatus } {
  if (!(error instanceof Error) || !("status" in error)) return false
  return error.status === 400 || error.status === 404 || error.status === 409
}

function appendMessage(deps: SubmitRunDeps, message: StoredMessage): void {
  if (deps.storage) {
    deps.storage.appendMessage(message)
    return
  }

  const existing = deps.messages?.get(message.sessionId) ?? []
  deps.messages?.set(message.sessionId, [...existing, message])
}

function makeMessageId(): string {
  return `msg_${randomUUID().replaceAll("-", "")}`
}

function recordRunResult(deps: SubmitRunDeps, runId: string, sessionId: string, result: RunResult): void {
  deps.runs.set(runId, {
    runId,
    sessionId,
    status: result.status,
    finalAnswer: result.finalAnswer,
  })
}

function recordRunFailure(deps: SubmitRunDeps, runId: string, sessionId: string, message: string): void {
  deps.runs.set(runId, {
    runId,
    sessionId,
    status: "failed",
    finalAnswer: message,
  })
}

function persistRunBestEffort(deps: SubmitRunDeps, run: Parameters<SQLiteStore["upsertRun"]>[0]): void {
  try {
    deps.storage?.upsertRun(run)
  } catch {
    // Terminal in-memory state is authoritative for this process; persistence is best-effort after completion.
  }
}

function appendMessageBestEffort(deps: SubmitRunDeps, message: StoredMessage): void {
  try {
    appendMessage(deps, message)
  } catch {
    // Message persistence must not reclassify the already-recorded run result.
  }
}

function captureBestEffort(deps: SubmitRunDeps, session: SessionState, environmentId: string): void {
  try {
    void deps.browserSessions.capture(session, environmentId).catch(() => null)
  } catch {
    // Browser capture is best-effort once terminal run state is recorded.
  }
}

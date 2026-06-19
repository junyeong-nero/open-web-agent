import { describe, expect, it } from "bun:test"
import { readFile, mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { MockAgent } from "@open-web-agent/agents"
import { MockBrowserToolAdapter, MockEnvironment } from "@open-web-agent/browser"
import {
  EventBus,
  PluginRegistry,
  RunOrchestrator,
  type AgentDecision,
  type AgentPlugin,
  type AgentState,
  type ActionResult,
  type BrowserEnvironment,
  type BrowserToolCall,
  type ModelPlugin,
  type ModelRequest,
  type ModelResponse,
  type Observation,
  type RunEvent,
  type RuntimeContext,
  type SessionState,
  type ToolAdapter,
} from "@open-web-agent/core"
import { readModelConfig } from "@open-web-agent/models"
import { SQLiteStore } from "@open-web-agent/storage"
import { createApp } from "./app"

async function setup(
  delayMs = 0,
  storage?: SQLiteStore,
  includeAlternateAgent = false,
  includeRuntimePlugins = false,
  modelConfigPath?: string,
) {
  const eventBus = new EventBus()
  const registry = new PluginRegistry()
  registry.registerAgent(new MockAgent())
  if (includeAlternateAgent) registry.registerAgent(new AlternateAgent())
  if (includeRuntimePlugins) {
    registry.registerAgent(new ContextAgent())
    registry.registerModel(new TestModel())
    registry.registerEnvironment(new AlternateEnvironment())
  }
  const mockEnvironment = new MockEnvironment(delayMs)
  registry.registerEnvironment(mockEnvironment)
  registry.registerToolAdapter(new MockBrowserToolAdapter(mockEnvironment))

  const orchestrator = new RunOrchestrator({
    home: await mkdtemp(join(tmpdir(), "owa-server-")),
    eventBus,
    registry,
    agentId: "mock-agent",
    environmentId: "mock-browser",
    maxSteps: 4,
    now: () => new Date("2026-06-17T00:00:00.000Z"),
  })

  const sessions = new Map()
  const app = createApp({ eventBus, orchestrator, registry, sessions, storage, modelConfigPath })

  return {
    app,
    eventBus,
    sessions,
    async request(path: string, init?: RequestInit): Promise<Response> {
      return await app.fetch(
        new Request(`http://127.0.0.1${path}`, {
          ...init,
          headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
        }),
      )
    },
  }
}

class AlternateAgent implements AgentPlugin {
  id = "alternate-agent"
  name = "Alternate Agent"
  description = "Returns a distinct final answer for agent selection tests."

  async initialize(): Promise<void> {}

  async step(_state: AgentState): Promise<AgentDecision> {
    return { type: "final_answer", thought: null, finalAnswer: "alternate answer", confidence: 1 }
  }

  async finalize(state: AgentState): Promise<string> {
    return state.finalAnswer ?? "alternate answer"
  }
}

class ContextAgent implements AgentPlugin {
  id = "context-agent"
  name = "Context Agent"
  description = "Reports selected runtime plugin ids."

  async initialize(): Promise<void> {}

  async step(_state: AgentState, ctx: RuntimeContext): Promise<AgentDecision> {
    return {
      type: "final_answer",
      thought: null,
      finalAnswer: `agent=${this.id} model=${ctx.modelId} browser=${ctx.environmentId}`,
      confidence: 1,
    }
  }

  async finalize(state: AgentState): Promise<string> {
    return state.finalAnswer ?? ""
  }
}

class BrowserActionAgent implements AgentPlugin {
  id = "browser-action-agent"
  name = "Browser Action Agent"
  description = "Updates the bound session browser through a tool call."

  async initialize(): Promise<void> {}

  async step(state: AgentState): Promise<AgentDecision> {
    if (state.steps.length > 0) {
      return { type: "final_answer", thought: null, finalAnswer: "browser updated", confidence: 1 }
    }

    return {
      type: "browser_actions",
      thought: "Navigate the session browser.",
      actions: [
        {
          id: "action_1",
          kind: "navigate",
          reason: "Open the after-run page",
          requiresApproval: false,
          toolCalls: [{ id: "tool_1", type: "navigate", url: "https://after-run.test/" }],
        },
      ],
    }
  }

  async finalize(state: AgentState): Promise<string> {
    return state.finalAnswer ?? "browser updated"
  }
}

class TestModel implements ModelPlugin {
  id = "test-model"
  name = "Test Model"
  provider = "test"
  modelName = "test-runtime-model"
  reasoningEffort = "medium"

  async complete(_request: ModelRequest, _ctx: RuntimeContext): Promise<ModelResponse> {
    return { id: "model_response_1", text: "{}", raw: {}, usage: null, latencyMs: 0 }
  }
}

class AlternateEnvironment implements BrowserEnvironment {
  id = "alternate-browser"
  name = "Alternate Browser"

  async reset(_ctx: RuntimeContext): Promise<void> {}

  async observe(_ctx: RuntimeContext): Promise<Observation> {
    return { url: "about:alternate", title: "Alternate", text: null, screenshotPath: null, interactiveElements: [], metadata: {} }
  }

  async close(_ctx: RuntimeContext): Promise<void> {}
}

class SessionLifecycleEnvironment implements BrowserEnvironment {
  id = "session-browser"
  name = "Session Browser"
  readonly openedSessionIds: string[] = []
  readonly attachedSessionIds: string[] = []
  readonly closedSessionIds: string[] = []
  readonly resetSessionIds: string[] = []
  private readonly observations = new Map<string, Observation>()

  async openSession(ctx: RuntimeContext): Promise<void> {
    this.openedSessionIds.push(ctx.session.id)
    this.observations.set(ctx.session.id, this.observations.get(ctx.session.id) ?? blankObservation())
  }

  async attachSession(ctx: RuntimeContext): Promise<void> {
    this.attachedSessionIds.push(ctx.session.id)
    this.observations.set(ctx.session.id, this.observations.get(ctx.session.id) ?? blankObservation())
  }

  async reset(ctx: RuntimeContext): Promise<void> {
    this.resetSessionIds.push(ctx.session.id)
    this.observations.set(ctx.session.id, this.observations.get(ctx.session.id) ?? blankObservation())
  }

  async observe(ctx: RuntimeContext): Promise<Observation> {
    return this.observations.get(ctx.session.id) ?? blankObservation()
  }

  async close(ctx: RuntimeContext): Promise<void> {
    this.closedSessionIds.push(ctx.session.id)
    this.observations.delete(ctx.session.id)
  }

  setObservation(sessionId: string, observation: Observation): void {
    this.observations.set(sessionId, observation)
  }
}

class SessionLifecycleToolAdapter implements ToolAdapter {
  id = "session-browser-tools"
  name = "Session Browser Tools"
  environmentId = "session-browser"

  constructor(private readonly environment: SessionLifecycleEnvironment) {}

  async execute(call: BrowserToolCall, ctx: RuntimeContext): Promise<ActionResult> {
    const observation: Observation = {
      url: call.type === "navigate" ? call.url : "https://after-run.test/",
      title: "After Run Browser",
      text: "After Run Browser",
      screenshotPath: null,
      interactiveElements: [],
      metadata: {},
    }
    this.environment.setObservation(ctx.session.id, observation)
    return { ok: true, message: null, observation, metadata: {} }
  }
}

function blankObservation(): Observation {
  return {
    url: "about:blank",
    title: null,
    text: null,
    screenshotPath: null,
    interactiveElements: [],
    metadata: {},
  }
}

async function setupSessionLifecycleApp() {
  const eventBus = new EventBus()
  const registry = new PluginRegistry()
  const environment = new SessionLifecycleEnvironment()
  registry.registerAgent(new AlternateAgent())
  registry.registerAgent(new BrowserActionAgent())
  registry.registerEnvironment(environment)
  registry.registerToolAdapter(new SessionLifecycleToolAdapter(environment))

  const orchestrator = new RunOrchestrator({
    home: await mkdtemp(join(tmpdir(), "owa-server-session-browser-")),
    eventBus,
    registry,
    agentId: "alternate-agent",
    environmentId: environment.id,
    maxSteps: 4,
    now: () => new Date("2026-06-17T00:00:00.000Z"),
  })

  const sessions = new Map<string, SessionState>()
  const app = createApp({ eventBus, orchestrator, registry, sessions })

  return {
    eventBus,
    environment,
    sessions,
    async request(path: string, init?: RequestInit): Promise<Response> {
      return await app.fetch(
        new Request(`http://127.0.0.1${path}`, {
          ...init,
          headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
        }),
      )
    },
  }
}

async function json<T>(response: Response): Promise<T> {
  expect(response.ok).toBe(true)
  return response.json() as Promise<T>
}

async function createSession(request: (path: string, init?: RequestInit) => Promise<Response>): Promise<string> {
  const response = await request("/sessions", {
    method: "POST",
    body: JSON.stringify({ projectPath: "/tmp/open-web-agent-project" }),
  })
  const body = await json<{ sessionId: string }>(response)
  return body.sessionId
}

function waitForEvent(eventBus: EventBus, type: RunEvent["type"]): Promise<RunEvent> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      unsubscribe()
      reject(new Error(`Timed out waiting for ${type}`))
    }, 1000)
    const unsubscribe = eventBus.subscribe((event) => {
      if (event.type !== type) return
      clearTimeout(timeout)
      unsubscribe()
      resolve(event)
    })
  })
}

describe("createApp", () => {
  it("GET /health returns ok", async () => {
    const { request } = await setup()

    expect(await json<{ ok: true }>(await request("/health"))).toEqual({ ok: true })
  })

  it("POST /sessions creates a session", async () => {
    const { request, sessions } = await setup()

    const sessionId = await createSession(request)

    expect(sessionId).toStartWith("ses_")
    expect(sessions.get(sessionId)).toMatchObject({
      projectPath: "/tmp/open-web-agent-project",
      title: null,
      pinned: false,
      deletedAt: null,
    })
  })

  it("POST /sessions opens a session-bound browser page", async () => {
    const { request, environment } = await setupSessionLifecycleApp()

    const response = await request("/sessions", {
      method: "POST",
      body: JSON.stringify({ projectPath: "/tmp/open-web-agent-project", environmentId: environment.id }),
    })
    const body = await json<{ sessionId: string; session: { environmentId: string; browser: Observation | null } }>(response)

    expect(environment.openedSessionIds).toEqual([body.sessionId])
    expect(body.session.environmentId).toBe(environment.id)
    expect(body.session.browser?.url).toBe("about:blank")
  })

  it("GET /sessions/:sessionId attaches the saved browser state for that session", async () => {
    const { request, environment } = await setupSessionLifecycleApp()
    const response = await request("/sessions", {
      method: "POST",
      body: JSON.stringify({ projectPath: "/tmp/open-web-agent-project", environmentId: environment.id }),
    })
    const { sessionId } = await json<{ sessionId: string }>(response)
    environment.setObservation(sessionId, {
      url: "https://example.com/",
      title: "Saved Browser State",
      text: "Saved Browser State",
      screenshotPath: null,
      interactiveElements: [],
      metadata: {},
    })

    const body = await json<{ id: string; browser: Observation | null }>(await request(`/sessions/${sessionId}`))

    expect(body.id).toBe(sessionId)
    expect(environment.attachedSessionIds).toEqual([sessionId])
    expect(body.browser?.title).toBe("Saved Browser State")
  })

  it("GET /sessions lists persisted sessions after app restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "owa-server-store-"))
    const storage = new SQLiteStore(join(directory, "metadata.sqlite"))
    storage.migrate()
    const first = await setup(0, storage)
    const sessionId = await createSession(first.request)

    const second = await setup(0, storage)
    const body = await json<{ sessions: Array<{ id: string; projectPath: string }> }>(await second.request("/sessions"))

    expect(body.sessions).toMatchObject([{ id: sessionId, projectPath: "/tmp/open-web-agent-project" }])
    storage.close()
  })

  it("GET /sessions/:sessionId attaches persisted sessions that do not have a browser id", async () => {
    const directory = await mkdtemp(join(tmpdir(), "owa-server-store-"))
    const storage = new SQLiteStore(join(directory, "metadata.sqlite"))
    storage.migrate()
    storage.upsertSession({
      id: "ses_legacy",
      projectPath: "/tmp/open-web-agent-project",
      projectHash: "hash",
      environmentId: null,
      title: null,
      pinned: false,
      deletedAt: null,
      createdAt: "2026-06-17T00:00:00.000Z",
    })
    const { request } = await setup(0, storage)

    const body = await json<{ environmentId: string; browser: Observation | null }>(await request("/sessions/ses_legacy"))

    expect(body.environmentId).toBe("mock-browser")
    expect(body.browser?.url).toBe("about:blank")
    storage.close()
  })

  it("PATCH /sessions/:sessionId renames and pins a session", async () => {
    const { request } = await setup()
    const sessionId = await createSession(request)

    const response = await request(`/sessions/${sessionId}`, {
      method: "PATCH",
      body: JSON.stringify({ title: "Repo commit check", pinned: true }),
    })
    const body = await json<{ id: string; title: string; pinned: boolean }>(response)

    expect(body).toMatchObject({ id: sessionId, title: "Repo commit check", pinned: true })
    expect(await json<{ sessions: Array<{ id: string; title: string; pinned: boolean }> }>(await request("/sessions"))).toMatchObject({
      sessions: [{ id: sessionId, title: "Repo commit check", pinned: true }],
    })
  })

  it("DELETE /sessions/:sessionId soft deletes a session and rejects new runs", async () => {
    const { request } = await setup()
    const sessionId = await createSession(request)

    expect((await request(`/sessions/${sessionId}`, { method: "DELETE" })).status).toBe(204)
    expect(await json<{ sessions: unknown[] }>(await request("/sessions"))).toEqual({ sessions: [] })

    const runResponse = await request("/runs", {
      method: "POST",
      body: JSON.stringify({ sessionId, prompt: "should not run" }),
    })

    expect(runResponse.status).toBe(404)
    expect(await runResponse.json()).toEqual({ error: "Unknown session" })
  })

  it("POST /runs starts a mock run", async () => {
    const { request, eventBus } = await setup()
    const sessionId = await createSession(request)
    const completed = waitForEvent(eventBus, "run.completed")

    const response = await request("/runs", {
      method: "POST",
      body: JSON.stringify({ sessionId, prompt: "example.com에 접속해서 페이지 제목을 알려줘" }),
    })
    const body = await json<{ runId: string }>(response)
    const event = await completed

    expect(body.runId).toStartWith("run_")
    expect(event.payload.finalAnswer).toBe('페이지 제목은 "Example Domain"입니다.')
  })

  it("POST /runs keeps the session browser open after the run completes", async () => {
    const { request, eventBus, environment } = await setupSessionLifecycleApp()
    const session = await request("/sessions", {
      method: "POST",
      body: JSON.stringify({ projectPath: "/tmp/open-web-agent-project", environmentId: environment.id }),
    })
    const { sessionId } = await json<{ sessionId: string }>(session)
    const completed = waitForEvent(eventBus, "run.completed")

    const { runId } = await json<{ runId: string }>(
      await request("/runs", {
        method: "POST",
        body: JSON.stringify({ sessionId, prompt: "answer directly", agentId: "alternate-agent", environmentId: environment.id }),
      }),
    )
    await completed
    await waitForRunStatus(request, runId, "completed")

    expect(environment.closedSessionIds).toEqual([])
  })

  it("POST /runs refreshes the cached session browser after tool actions", async () => {
    const { request, eventBus, environment } = await setupSessionLifecycleApp()
    const session = await request("/sessions", {
      method: "POST",
      body: JSON.stringify({ projectPath: "/tmp/open-web-agent-project", environmentId: environment.id }),
    })
    const { sessionId } = await json<{ sessionId: string }>(session)
    const completed = waitForEvent(eventBus, "run.completed")

    const { runId } = await json<{ runId: string }>(
      await request("/runs", {
        method: "POST",
        body: JSON.stringify({ sessionId, prompt: "update browser", agentId: "browser-action-agent", environmentId: environment.id }),
      }),
    )
    await completed
    await waitForRunStatus(request, runId, "completed")

    const renamed = await json<{ browser: Observation | null }>(
      await request(`/sessions/${sessionId}`, {
        method: "PATCH",
        body: JSON.stringify({ title: "Renamed after run" }),
      }),
    )

    expect(renamed.browser?.title).toBe("After Run Browser")
  })

  it("POST /runs can select a registered agent", async () => {
    const { request, eventBus } = await setup(0, undefined, true)
    const sessionId = await createSession(request)
    const completed = waitForEvent(eventBus, "run.completed")

    const response = await request("/runs", {
      method: "POST",
      body: JSON.stringify({ sessionId, prompt: "answer directly", agentId: "alternate-agent" }),
    })
    await json<{ runId: string }>(response)

    expect((await completed).payload.finalAnswer).toBe("alternate answer")
  })

  it("POST /runs rejects an unknown agent", async () => {
    const { request } = await setup(0, undefined, true)
    const sessionId = await createSession(request)

    const response = await request("/runs", {
      method: "POST",
      body: JSON.stringify({ sessionId, prompt: "answer directly", agentId: "missing-agent" }),
    })

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: "Unknown agent" })
  })

  it("POST /runs can select model and browser for a run", async () => {
    const { request, eventBus } = await setup(0, undefined, false, true)
    const sessionId = await createSession(request)
    const completed = waitForEvent(eventBus, "run.completed")

    const response = await request("/runs", {
      method: "POST",
      body: JSON.stringify({
        sessionId,
        prompt: "report context",
        agentId: "context-agent",
        modelId: "test-model",
        environmentId: "alternate-browser",
      }),
    })
    await json<{ runId: string }>(response)

    expect((await completed).payload.finalAnswer).toBe("agent=context-agent model=test-model browser=alternate-browser")
  })

  it("POST /runs rejects unknown model and browser ids", async () => {
    const { request } = await setup(0, undefined, false, true)
    const sessionId = await createSession(request)

    const missingModel = await request("/runs", {
      method: "POST",
      body: JSON.stringify({ sessionId, prompt: "report context", agentId: "context-agent", modelId: "missing-model" }),
    })
    const missingBrowser = await request("/runs", {
      method: "POST",
      body: JSON.stringify({ sessionId, prompt: "report context", agentId: "context-agent", environmentId: "missing-browser" }),
    })

    expect(missingModel.status).toBe(400)
    expect(await missingModel.json()).toEqual({ error: "Unknown model" })
    expect(missingBrowser.status).toBe(400)
    expect(await missingBrowser.json()).toEqual({ error: "Unknown browser" })
  })

  it("GET /events streams live RunEvent SSE messages", async () => {
    const { request, eventBus } = await setup()
    const response = await request("/events")
    const reader = response.body?.getReader()
    if (!reader) throw new Error("SSE body missing")
    const connectedText = await readUntil(reader, ": connected")

    const event: RunEvent = {
      id: "evt_1",
      runId: "run_1",
      sessionId: "ses_1",
      stepId: null,
      sequence: 0,
      type: "run.started",
      payload: { prompt: "hello" },
      createdAt: "2026-06-17T00:00:00.000Z",
    }
    await eventBus.publish(event)
    const text = connectedText + (await readUntil(reader, "event: run.started"))
    await reader.cancel()

    expect(response.headers.get("content-type")).toContain("text/event-stream")
    expect(text).toContain("event: run.started")
    expect(text).toContain("id: 0")
    expect(text).toContain(`data: ${JSON.stringify(event)}`)
  })

  it("GET /plugins lists registered mock plugins", async () => {
    const { request } = await setup()

    const body = await json<{
      agents: Array<{ id: string; name: string; description: string }>
      environments: Array<{ id: string; name: string }>
      models: Array<{ id: string; name: string; provider: string }>
    }>(await request("/plugins"))

    expect(body.agents).toEqual([{ id: "mock-agent", name: "Mock Agent", description: "Deterministic Sprint 1 agent for Example Domain." }])
    expect(body.environments).toEqual([{ id: "mock-browser", name: "Mock Browser" }])
    expect(body.models).toEqual([])
  })

  it("PATCH /config/model persists a selected model provider for future sessions", async () => {
    const dir = await mkdtemp(join(tmpdir(), "owa-server-config-"))
    const configPath = join(dir, ".config.yaml")
    const { request } = await setup(0, undefined, false, true, configPath)

    const response = await request("/config/model", {
      method: "PATCH",
      body: JSON.stringify({ modelId: "test-model" }),
    })
    const body = await json<{ modelId: string; modelName: string | null; reasoningEffort: string | null }>(response)

    expect(body).toEqual({ modelId: "test-model", modelName: "test-runtime-model", reasoningEffort: "medium" })
    await readFile(configPath, "utf8")
    expect(readModelConfig({}, { configPath })).toMatchObject({
      defaultModel: "test-runtime-model",
      defaultModelProvider: "test-model",
      reasoningEffort: "medium",
    })
  })

  it("PATCH /config/model persists reasoning effort changes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "owa-server-config-"))
    const configPath = join(dir, ".config.yaml")
    const { request } = await setup(0, undefined, false, true, configPath)

    const response = await request("/config/model", {
      method: "PATCH",
      body: JSON.stringify({ modelId: "test-model", reasoningEffort: "high" }),
    })
    const body = await json<{ modelId: string; modelName: string | null; reasoningEffort: string | null }>(response)

    expect(body).toEqual({ modelId: "test-model", modelName: "test-runtime-model", reasoningEffort: "high" })
    expect(readModelConfig({}, { configPath })).toMatchObject({
      defaultModel: "test-runtime-model",
      defaultModelProvider: "test-model",
      reasoningEffort: "high",
    })
    expect((await json<{ models: Array<{ id: string; reasoningEffort: string | null }> }>(await request("/plugins/models"))).models).toContainEqual(
      expect.objectContaining({ id: "test-model", reasoningEffort: "high" }),
    )
  })

  it("PATCH /config/model rejects an unknown model provider", async () => {
    const dir = await mkdtemp(join(tmpdir(), "owa-server-config-"))
    const { request } = await setup(0, undefined, false, true, join(dir, ".config.yaml"))

    const response = await request("/config/model", {
      method: "PATCH",
      body: JSON.stringify({ modelId: "missing-model" }),
    })

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: "Unknown model" })
  })

  it("PATCH /config/agent persists a selected agent for future sessions", async () => {
    const dir = await mkdtemp(join(tmpdir(), "owa-server-config-"))
    const configPath = join(dir, ".config.yaml")
    const { request } = await setup(0, undefined, true, false, configPath)

    const response = await request("/config/agent", {
      method: "PATCH",
      body: JSON.stringify({ agentId: "alternate-agent" }),
    })
    const body = await json<{ agentId: string }>(response)

    expect(body).toEqual({ agentId: "alternate-agent" })
    expect(readModelConfig({}, { configPath })).toMatchObject({
      defaultAgentId: "alternate-agent",
    })
  })

  it("PATCH /config/agent rejects an unknown agent", async () => {
    const dir = await mkdtemp(join(tmpdir(), "owa-server-config-"))
    const { request } = await setup(0, undefined, true, false, join(dir, ".config.yaml"))

    const response = await request("/config/agent", {
      method: "PATCH",
      body: JSON.stringify({ agentId: "missing-agent" }),
    })

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: "Unknown agent" })
  })

  it("PATCH /config/browser persists a selected browser for future sessions", async () => {
    const dir = await mkdtemp(join(tmpdir(), "owa-server-config-"))
    const configPath = join(dir, ".config.yaml")
    const { request } = await setup(0, undefined, false, true, configPath)

    const response = await request("/config/browser", {
      method: "PATCH",
      body: JSON.stringify({ browserId: "alternate-browser" }),
    })
    const body = await json<{ browserId: string }>(response)

    expect(body).toEqual({ browserId: "alternate-browser" })
    expect(readModelConfig({}, { configPath })).toMatchObject({
      defaultBrowserId: "alternate-browser",
    })
  })

  it("PATCH /config/browser rejects an unknown browser", async () => {
    const dir = await mkdtemp(join(tmpdir(), "owa-server-config-"))
    const { request } = await setup(0, undefined, false, true, join(dir, ".config.yaml"))

    const response = await request("/config/browser", {
      method: "PATCH",
      body: JSON.stringify({ browserId: "missing-browser" }),
    })

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: "Unknown browser" })
  })

  it("POST /runs/:runId/cancel returns cancelled false for an unknown run", async () => {
    const { request } = await setup()

    expect(await json<{ cancelled: boolean }>(await request("/runs/run_missing/cancel", { method: "POST" }))).toEqual({
      cancelled: false,
    })
  })

  it("POST /runs/:runId/cancel cancels an active delayed run", async () => {
    const { request, eventBus } = await setup(50)
    const sessionId = await createSession(request)
    const cancelled = waitForEvent(eventBus, "run.cancelled")
    const run = await json<{ runId: string }>(
      await request("/runs", {
        method: "POST",
        body: JSON.stringify({ sessionId, prompt: "example.com에 접속해서 페이지 제목을 알려줘" }),
      }),
    )

    expect(await json<{ cancelled: boolean }>(await request(`/runs/${run.runId}/cancel`, { method: "POST" }))).toEqual({
      cancelled: true,
    })
    expect((await cancelled).type).toBe("run.cancelled")
  })
})

async function readUntil(reader: ReadableStreamDefaultReader<Uint8Array>, pattern: string): Promise<string> {
  let text = ""
  while (!text.includes(pattern)) {
    const chunk = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Timed out reading SSE")), 1000)),
    ])
    text += new TextDecoder().decode(chunk.value)
  }
  return text
}

async function waitForRunStatus(
  request: (path: string, init?: RequestInit) => Promise<Response>,
  runId: string,
  status: string,
): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const run = await json<{ status: string }>(await request(`/runs/${runId}`))
    if (run.status === status) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`Timed out waiting for ${runId} to become ${status}`)
}

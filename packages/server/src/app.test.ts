import { describe, expect, it } from "bun:test"
import { mkdtemp } from "node:fs/promises"
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
  type BrowserEnvironment,
  type ModelPlugin,
  type ModelRequest,
  type ModelResponse,
  type Observation,
  type RunEvent,
  type RuntimeContext,
} from "@open-web-agent/core"
import { SQLiteStore } from "@open-web-agent/storage"
import { createApp } from "./app"

async function setup(delayMs = 0, storage?: SQLiteStore, includeAlternateAgent = false, includeRuntimePlugins = false) {
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
  const app = createApp({ eventBus, orchestrator, registry, sessions, storage })

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

class TestModel implements ModelPlugin {
  id = "test-model"
  name = "Test Model"
  provider = "test"

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

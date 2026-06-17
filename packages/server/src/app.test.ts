import { describe, expect, it } from "bun:test"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { MockAgent } from "@open-web-agent/agents"
import { MockEnvironment } from "@open-web-agent/browser"
import { EventBus, PluginRegistry, RunOrchestrator, type RunEvent } from "@open-web-agent/core"
import { createApp } from "./app"

async function setup(delayMs = 0) {
  const eventBus = new EventBus()
  const registry = new PluginRegistry()
  registry.registerAgent(new MockAgent())
  registry.registerEnvironment(new MockEnvironment(delayMs))

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
  const app = createApp({ eventBus, orchestrator, registry, sessions })

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
    expect(sessions.get(sessionId)?.projectPath).toBe("/tmp/open-web-agent-project")
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

  it("GET /events streams live RunEvent SSE messages", async () => {
    const { request, eventBus } = await setup()
    const response = await request("/events")
    const reader = response.body?.getReader()
    if (!reader) throw new Error("SSE body missing")
    await new Promise((resolve) => setTimeout(resolve, 0))

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
    const chunk = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Timed out reading SSE")), 1000)),
    ])
    await reader.cancel()

    const text = new TextDecoder().decode(chunk.value)
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

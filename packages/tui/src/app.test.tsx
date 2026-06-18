/** @jsxImportSource @opentui/solid */
import { afterEach, describe, expect, it } from "bun:test"
import { TextareaRenderable } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { App } from "./app"

const servers: Array<Bun.Server<undefined>> = []

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true)
})

describe("App", () => {
  it("lets the focused prompt complete slash commands before tab changes panes", async () => {
    const server = startTuiServer()
    const setup = await testRender(
      () => <App serverUrl={server.url} projectPath="/tmp/open-web-agent-test" onExit={() => {}} />,
      { width: 100, height: 24 },
    )

    try {
      await setup.flush()
      const textarea = setup.renderer.root.findDescendantById("prompt-input-textarea")

      expect(textarea).toBeInstanceOf(TextareaRenderable)

      await setup.mockInput.typeText("/ag")
      await setup.flush()

      expect((textarea as TextareaRenderable).plainText).toBe("/ag")

      setup.mockInput.pressTab()
      await setup.flush()

      expect((textarea as TextareaRenderable).plainText).toBe("/agent ")
    } finally {
      setup.renderer.destroy()
    }
  })

  it("persists model changes made through the /model command", async () => {
    const persisted: unknown[] = []
    const server = startTuiServer({ onPersistModel: (body) => persisted.push(body) })
    const setup = await testRender(
      () => <App serverUrl={server.url} projectPath="/tmp/open-web-agent-test" onExit={() => {}} />,
      { width: 100, height: 24 },
    )

    try {
      await setup.flush()

      await setup.mockInput.typeText("/model test-model")
      setup.mockInput.pressEnter()
      await setup.flush()
      await eventually(() => expect(persisted).toEqual([{ modelId: "test-model" }]))
    } finally {
      setup.renderer.destroy()
    }
  })

  it("persists agent and browser changes made through slash commands", async () => {
    const persistedAgents: unknown[] = []
    const persistedBrowsers: unknown[] = []
    const server = startTuiServer({
      onPersistAgent: (body) => persistedAgents.push(body),
      onPersistBrowser: (body) => persistedBrowsers.push(body),
    })
    const setup = await testRender(
      () => <App serverUrl={server.url} projectPath="/tmp/open-web-agent-test" onExit={() => {}} />,
      { width: 100, height: 24 },
    )

    try {
      await setup.flush()

      await setup.mockInput.typeText("/agent test-agent")
      setup.mockInput.pressEnter()
      await setup.flush()
      await eventually(() => expect(persistedAgents).toEqual([{ agentId: "test-agent" }]))

      await setup.mockInput.typeText("/browser test-browser")
      setup.mockInput.pressEnter()
      await setup.flush()
      await eventually(() => expect(persistedBrowsers).toEqual([{ browserId: "test-browser" }]))
    } finally {
      setup.renderer.destroy()
    }
  })
})

function startTuiServer(
  options: {
    onPersistModel?: (body: unknown) => void
    onPersistAgent?: (body: unknown) => void
    onPersistBrowser?: (body: unknown) => void
  } = {},
): { url: string } {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url)
      if (url.pathname === "/sessions" && request.method === "POST") {
        return Response.json({ sessionId: sessionSummary.id, session: sessionSummary })
      }
      if (url.pathname === "/sessions" && request.method === "GET") {
        return Response.json({ sessions: [sessionSummary] })
      }
      if (url.pathname === "/plugins" && request.method === "GET") {
        return Response.json({
          agents: [{ id: "test-agent", name: "Test Agent", description: "Agent used by TUI tests." }],
          models: [{ id: "test-model", name: "Test Model", provider: "test", modelName: "test-runtime-model" }],
          environments: [{ id: "test-browser", name: "Test Browser" }],
        })
      }
      if (url.pathname === "/config/model" && request.method === "PATCH") {
        return request.json().then((body) => {
          options.onPersistModel?.(body)
          return Response.json({ modelId: "test-model", modelName: "test-runtime-model" })
        })
      }
      if (url.pathname === "/config/agent" && request.method === "PATCH") {
        return request.json().then((body) => {
          options.onPersistAgent?.(body)
          return Response.json({ agentId: "test-agent" })
        })
      }
      if (url.pathname === "/config/browser" && request.method === "PATCH") {
        return request.json().then((body) => {
          options.onPersistBrowser?.(body)
          return Response.json({ browserId: "test-browser" })
        })
      }
      if (url.pathname === "/events" && request.method === "GET") {
        return new Response(new ReadableStream(), { headers: { "content-type": "text/event-stream" } })
      }
      return new Response("not found", { status: 404 })
    },
  })
  servers.push(server)
  return { url: `http://${server.hostname}:${server.port}` }
}

async function eventually(assertion: () => void): Promise<void> {
  const startedAt = Date.now()
  let lastError: unknown
  while (Date.now() - startedAt < 1000) {
    try {
      assertion()
      return
    } catch (error) {
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }
  throw lastError
}

const sessionSummary = {
  id: "ses_test",
  projectPath: "/tmp/open-web-agent-test",
  projectHash: "hash",
  title: null,
  pinned: false,
  deletedAt: null,
  createdAt: "2026-06-17T00:00:00.000Z",
  runStatus: "idle",
}

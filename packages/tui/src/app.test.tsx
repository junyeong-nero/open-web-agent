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

  it("focuses the prompt and inserts printable text when typing from another pane", async () => {
    const server = startTuiServer()
    const setup = await testRender(
      () => <App serverUrl={server.url} projectPath="/tmp/open-web-agent-test" onExit={() => {}} />,
      { width: 100, height: 24 },
    )

    try {
      await setup.flush()
      const textarea = setup.renderer.root.findDescendantById("prompt-input-textarea")

      expect(textarea).toBeInstanceOf(TextareaRenderable)

      setup.mockInput.pressTab()
      await setup.flush()
      await setup.mockInput.typeText("h")
      await setup.flush()

      expect((textarea as TextareaRenderable).focused).toBe(true)
      expect((textarea as TextareaRenderable).plainText).toBe("h")
    } finally {
      setup.renderer.destroy()
    }
  })

  it("loads global prompt history and recalls it in a fresh app session", async () => {
    const server = startTuiServer()
    const setup = await testRender(
      () => (
        <App
          serverUrl={server.url}
          projectPath="/tmp/open-web-agent-test"
          initialPromptHistory={["persisted prompt"]}
          onExit={() => {}}
        />
      ),
      { width: 100, height: 24 },
    )

    try {
      await setup.flush()
      const textarea = setup.renderer.root.findDescendantById("prompt-input-textarea")

      expect(textarea).toBeInstanceOf(TextareaRenderable)

      await eventually(async () => {
        setup.mockInput.pressArrow("up")
        await setup.flush()
        expect((textarea as TextareaRenderable).plainText).toBe("persisted prompt")
      })
    } finally {
      setup.renderer.destroy()
    }
  })

  it("persists reasoning effort changes with right and left arrows for supported models", async () => {
    const persisted: unknown[] = []
    const server = startTuiServer({
      models: [{ id: "test-model", name: "Test Model", provider: "test", modelName: "test-runtime-model", reasoningEffort: "medium" }],
      onPersistModel: (body) => persisted.push(body),
    })
    const setup = await testRender(
      () => (
        <App
          serverUrl={server.url}
          projectPath="/tmp/open-web-agent-test"
          initialRuntimePlugins={{
            agents: [],
            models: [{ id: "test-model", name: "Test Model", provider: "test", modelName: "test-runtime-model", reasoningEffort: "medium" }],
            environments: [],
          }}
          onExit={() => {}}
        />
      ),
      { width: 100, height: 24 },
    )

    try {
      await setup.flush()

      setup.mockInput.pressArrow("right")
      await setup.flush()
      setup.mockInput.pressArrow("left")
      await setup.flush()

      await eventually(() =>
        expect(persisted).toEqual([
          { modelId: "test-model", reasoningEffort: "high" },
          { modelId: "test-model", reasoningEffort: "medium" },
        ]),
      )
    } finally {
      setup.renderer.destroy()
    }
  })

  it("leaves reasoning effort unchanged for models without effort support", async () => {
    const persisted: unknown[] = []
    const server = startTuiServer({ onPersistModel: (body) => persisted.push(body) })
    const setup = await testRender(
      () => <App serverUrl={server.url} projectPath="/tmp/open-web-agent-test" onExit={() => {}} />,
      { width: 100, height: 24 },
    )

    try {
      await setup.flush()

      setup.mockInput.pressArrow("right")
      await setup.flush()

      expect(persisted).toEqual([])
    } finally {
      setup.renderer.destroy()
    }
  })
})

function startTuiServer(
  options: {
    models?: Array<{ id: string; name: string; provider: string; modelName: string; reasoningEffort?: string | null }>
    onPersistModel?: (body: unknown) => void
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
          agents: [],
          models: options.models ?? [{ id: "test-model", name: "Test Model", provider: "test", modelName: "test-runtime-model" }],
          environments: [],
        })
      }
      if (url.pathname === "/config/model" && request.method === "PATCH") {
        return request.json().then((body) => {
          options.onPersistModel?.(body)
          return Response.json({ modelId: "test-model", modelName: "test-runtime-model" })
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

async function eventually(assertion: () => void | Promise<void>): Promise<void> {
  const startedAt = Date.now()
  let lastError: unknown
  while (Date.now() - startedAt < 1000) {
    try {
      await assertion()
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

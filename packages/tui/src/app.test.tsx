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
})

function startTuiServer(): { url: string } {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url)
      if (url.pathname === "/sessions" && request.method === "POST") {
        return Response.json({ sessionId: "ses_test" })
      }
      if (url.pathname === "/plugins" && request.method === "GET") {
        return Response.json({ agents: [], models: [], environments: [] })
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

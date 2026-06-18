import { afterEach, describe, expect, it } from "bun:test"
import { createServerClient } from "./server-client"

const servers: Array<Bun.Server<undefined>> = []

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true)
})

describe("createServerClient", () => {
  it("sends the selected browser environment when creating a session", async () => {
    const requests: unknown[] = []
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const url = new URL(request.url)
        if (url.pathname === "/sessions" && request.method === "POST") {
          requests.push(await request.json())
          return Response.json({
            sessionId: "ses_test",
            session: {
              id: "ses_test",
              projectPath: "/tmp/open-web-agent-test",
              projectHash: "hash",
              title: null,
              pinned: false,
              deletedAt: null,
              createdAt: "2026-06-17T00:00:00.000Z",
              runStatus: "idle",
              environmentId: "playwright-browser",
              browser: null,
            },
          })
        }
        return new Response("not found", { status: 404 })
      },
    })
    servers.push(server)

    await createServerClient(`http://${server.hostname}:${server.port}`).createSession(
      "/tmp/open-web-agent-test",
      "playwright-browser",
    )

    expect(requests).toEqual([
      {
        projectPath: "/tmp/open-web-agent-test",
        environmentId: "playwright-browser",
      },
    ])
  })

  it("persists selected agent and browser ids", async () => {
    const requests: Array<{ path: string; body: unknown }> = []
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const url = new URL(request.url)
        if (url.pathname === "/config/agent" && request.method === "PATCH") {
          requests.push({ path: url.pathname, body: await request.json() })
          return Response.json({ agentId: "plan-act-agent" })
        }
        if (url.pathname === "/config/browser" && request.method === "PATCH") {
          requests.push({ path: url.pathname, body: await request.json() })
          return Response.json({ browserId: "playwright-browser" })
        }
        return new Response("not found", { status: 404 })
      },
    })
    servers.push(server)

    const client = createServerClient(`http://${server.hostname}:${server.port}`)
    expect(await client.selectAgent("plan-act-agent")).toEqual({ agentId: "plan-act-agent" })
    expect(await client.selectBrowser("playwright-browser")).toEqual({ browserId: "playwright-browser" })

    expect(requests).toEqual([
      { path: "/config/agent", body: { agentId: "plan-act-agent" } },
      { path: "/config/browser", body: { browserId: "playwright-browser" } },
    ])
  })

  it("sends reasoning effort when selecting a model with effort changes", async () => {
    const requests: unknown[] = []
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const url = new URL(request.url)
        if (url.pathname === "/config/model" && request.method === "PATCH") {
          requests.push(await request.json())
          return Response.json({ modelId: "test-model", modelName: "test-runtime-model", reasoningEffort: "high" })
        }
        return new Response("not found", { status: 404 })
      },
    })
    servers.push(server)

    await createServerClient(`http://${server.hostname}:${server.port}`).selectModel("test-model", "high")

    expect(requests).toEqual([{ modelId: "test-model", reasoningEffort: "high" }])
  })
})

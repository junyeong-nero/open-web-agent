import { afterAll, describe, expect, it } from "bun:test"
import { join } from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { refFor, startFixtureServer } from "./testing/fixture"

const fixture = startFixtureServer()
const clients: Client[] = []

async function connect(...args: string[]): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(import.meta.dir, "cli.ts"), "mcp", "--headless", ...args],
    env: { ...process.env } as Record<string, string>,
    stderr: "inherit",
  })
  const client = new Client({ name: "owa-test", version: "0.0.0" })
  await client.connect(transport)
  clients.push(client)
  return client
}

function text(result: Awaited<ReturnType<Client["callTool"]>>): string {
  return (result.content as Array<{ type: string; text?: string }>).map((part) => part.text ?? "").join("\n")
}

afterAll(async () => {
  await Promise.all(clients.map((client) => client.close()))
  fixture.stop()
})

describe("owa mcp (via the official MCP SDK client)", () => {
  it("lists and calls browser tools over stdio", async () => {
    const client = await connect()
    expect(client.getServerVersion()?.name).toBe("open-web-agent")

    const { tools } = await client.listTools()
    expect(tools.map((tool) => tool.name)).toContain("browser_navigate")
    expect(tools.map((tool) => tool.name)).toContain("browser_tabs")
    expect(tools.map((tool) => tool.name)).toContain("browser_select_tab")
    expect(tools.map((tool) => tool.name)).not.toContain("browser_task")
    expect(tools.find((tool) => tool.name === "browser_snapshot")?.annotations?.readOnlyHint).toBe(true)

    const navigated = await client.callTool({ name: "browser_navigate", arguments: { url: `${fixture.url}/` } })
    expect(navigated.isError).toBe(false)
    const tabs = JSON.parse(text(await client.callTool({ name: "browser_tabs", arguments: {} })))
    const selected = await client.callTool({ name: "browser_select_tab", arguments: { tabId: tabs[0].id } })
    expect(text(selected)).toContain("Page tab: " + tabs[0].id)

    const clicked = await client.callTool({ name: "browser_click", arguments: { ref: refFor(text(selected), /link "Pricing" \[/) } })
    expect(text(clicked)).toContain("Page title: Pricing")

    const screenshot = await client.callTool({ name: "browser_screenshot", arguments: {} })
    expect((screenshot.content as Array<{ type: string }>).map((part) => part.type)).toEqual(["text", "image"])

    const failed = await client.callTool({ name: "browser_click", arguments: { ref: "bad" } })
    expect(failed.isError).toBe(true)
  }, 30_000)

  it("exposes browser_task backed by the built-in agent with --agent", async () => {
    const client = await connect("--agent", "--model-module", join(import.meta.dir, "testing", "scripted-model-module.ts"))
    const { tools } = await client.listTools()
    expect(tools.map((tool) => tool.name)).toContain("browser_task")

    const result = await client.callTool({ name: "browser_task", arguments: { task: `Find the Pro price on ${fixture.url}/` } })
    expect(text(result)).toStartWith("$42")
    expect(text(result)).toContain("status: completed")
  }, 30_000)
})


it("passes model options to the delegated model through the MCP CLI", async () => {
  const bodies: any[] = []
  const endpoint = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      bodies.push(await request.json())
      return Response.json({ choices: [{ message: { content: "configured" } }] })
    },
  })
  try {
    const client = await connect("--agent", "--model", "ollama:local", "--api", "openai", "--base-url", `http://127.0.0.1:${endpoint.port}`, "--model-options", '{"reasoning_effort":"none"}')
    const result = await client.callTool({ name: "browser_task", arguments: { task: "Reply configured" } })
    expect(result.isError).toBe(false)
    expect(text(result)).toContain("configured")
    expect(bodies[0].reasoning_effort).toBe("none")
    expect(bodies[0].tools.length).toBeGreaterThan(0)
  } finally { endpoint.stop(true) }
})

it("returns compact structured outcomes and marks incomplete delegation as an error", async () => {
  const { BrowserSession } = await import("./browser")
  const { createMcpServer } = await import("./mcp")
  const { selectTools } = await import("./tools")
  const { scriptedModel } = await import("./testing/scripted-model")
  for (const outcome of ["succeeded", "partial", "blocked"]) {
    const session = new BrowserSession({ headless: true })
    const server = createMcpServer({ session, tools: selectTools(), agentModel: scriptedModel([
      (request) => {
        expect(request.messages[0]).toMatchObject({ role: "user", content: [{ type: "text", text: expect.stringMatching(/^Today is .+\n\nTask: t\n/) }] })
        return { text: JSON.stringify({ answer: "answer", outcome, unfinished: outcome === "succeeded" ? [] : ["Read price"] }), toolCalls: [] }
      },
    ]) })
    const response = await server.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "browser_task", arguments: { task: "t" } } })
    const result = response?.result as any
    expect(result.isError).toBe(outcome !== "succeeded")
    expect(result.structuredContent.outcome).toMatchObject({ status: outcome, verification: "unverified" })
    expect(result.structuredContent.stopReason).toBe("final_answer")
    expect(result.content[0].text).toStartWith("answer")
    expect(result.structuredContent).not.toHaveProperty("messages")
    await session.close()
  }
})

it("marks a step-limited task as incomplete even when its last answer claims success", async () => {
  const { BrowserSession } = await import("./browser")
  const { createMcpServer } = await import("./mcp")
  const { scriptedModel } = await import("./testing/scripted-model")
  const session = new BrowserSession({ headless: true })
  const server = createMcpServer({ session, tools: [], agentModel: scriptedModel([
    () => ({ toolCalls: [{ id: "1", name: "missing", arguments: {} }] }),
    () => ({ text: '{"answer":"best effort","outcome":"succeeded","unfinished":[]}', toolCalls: [] }),
  ]) })
  const response = await server.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "browser_task", arguments: { task: "t", maxSteps: 1 } } })
  const result = response?.result as any
  expect(result.isError).toBe(true)
  expect(result.structuredContent).toMatchObject({ status: "max_steps", stopReason: "step_limit", answer: "best effort" })
  await session.close()
})

it("accepts SDK cancellation over stdio and releases the delegated-task queue", async () => {
  let started!: () => void
  const entered = new Promise<void>(resolve => { started = resolve })
  let requests = 0
  const endpoint = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch() {
    if (++requests === 1) { started(); return new Promise<Response>(() => {}) }
    return Response.json({ choices: [{ message: { content: 'next task\n{"outcome":"succeeded","unfinished":[]}' } }] })
  } })
  try {
    const client = await connect("--agent", "--model", "ollama:local", "--api", "openai", "--base-url", `http://127.0.0.1:${endpoint.port}`)
    const controller = new AbortController()
    const first = client.callTool({ name: "browser_task", arguments: { task: "wait" } }, undefined, { signal: controller.signal }).catch(() => "cancelled")
    await entered
    controller.abort()
    expect(await first).toBe("cancelled")
    const result = await client.callTool({ name: "browser_task", arguments: { task: "next" } })
    expect(text(result)).toStartWith("next task")
    expect(result.isError).toBe(false)
    expect(requests).toBe(2)
  } finally { endpoint.stop(true) }
}, 10_000)

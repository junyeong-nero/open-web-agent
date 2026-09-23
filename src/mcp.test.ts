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
    expect(tools.map((tool) => tool.name)).not.toContain("browser_task")
    expect(tools.find((tool) => tool.name === "browser_snapshot")?.annotations?.readOnlyHint).toBe(true)

    const navigated = await client.callTool({ name: "browser_navigate", arguments: { url: `${fixture.url}/` } })
    expect(navigated.isError).toBe(false)
    const clicked = await client.callTool({ name: "browser_click", arguments: { ref: refFor(text(navigated), /link "Pricing" \[/) } })
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

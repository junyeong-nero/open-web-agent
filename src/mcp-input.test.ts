import { expect, it } from "bun:test"
import { join } from "node:path"
import { createInterface } from "node:readline"
import { Readable } from "node:stream"
import { BrowserSession } from "./browser"
import { createMcpServer } from "./mcp"

const invalid = [null, [], 42, "ping", {}, { jsonrpc: "1.0", method: "ping" },
  { jsonrpc: "2.0", method: 3 }, { jsonrpc: "2.0", method: "ping", id: {} },
  { jsonrpc: "2.0", method: "ping", params: [] }, { jsonrpc: "2.0", method: "ping", params: null }]

it.each(invalid)("rejects malformed request %p without breaking the next call", async input => {
  const server = createMcpServer({ session: new BrowserSession(), tools: [] })
  expect(await server.handle(input)).toMatchObject({ jsonrpc: "2.0", id: null, error: { code: -32600 } })
  expect(await server.handle({ jsonrpc: "2.0", id: "next", method: "ping" })).toEqual({ jsonrpc: "2.0", id: "next", result: {} })
})

it("accepts valid notifications and preserves request IDs", async () => {
  const server = createMcpServer({ session: new BrowserSession(), tools: [] })
  expect(await server.handle({ jsonrpc: "2.0", method: "notifications/initialized" })).toBeUndefined()
  for (const id of [0, "request", null]) {
    expect(await server.handle({ jsonrpc: "2.0", id, method: "ping" })).toEqual({ jsonrpc: "2.0", id, result: {} })
  }
})

it("survives malformed stdio input while stdin stays open", async () => {
  const proc = Bun.spawn([process.execPath, join(import.meta.dir, "cli.ts"), "mcp"], { stdin: "pipe", stdout: "pipe", stderr: "pipe" })
  try {
    const lines = createInterface({ input: Readable.from(proc.stdout), crlfDelay: Infinity })
    proc.stdin.write("{invalid-json\n" + invalid.map(input => JSON.stringify(input)).join("\n") + '\n{"jsonrpc":"2.0","id":"alive","method":"tools/list"}\n')
    await proc.stdin.flush()
    const replies: any[] = []
    for await (const line of lines) {
      const reply = JSON.parse(line)
      replies.push(reply)
      if (reply.id === "alive") break
    }
    expect(replies).toHaveLength(invalid.length + 2)
    expect(replies[0].error.code).toBe(-32700)
    expect(replies.slice(1, -1).every(reply => reply.error.code === -32600)).toBe(true)
    expect(replies.at(-1).result.tools.length).toBeGreaterThan(0)
    proc.stdin.end()
    expect(await proc.exited).toBe(0)
    expect(await new Response(proc.stderr).text()).toBe("")
  } finally { if (proc.exitCode === null) proc.kill() }
}, 10_000)

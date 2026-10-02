import { expect, it } from "bun:test"
import { z } from "zod"
import { runAgent, render } from "./agent"
import { BrowserSession } from "./browser"
import { createMcpServer } from "./mcp"
import { startFixtureServer } from "./testing/fixture"
import { scriptedModel } from "./testing/scripted-model"
import { selectTools, type BrowserTool } from "./tools"

it("keeps only the latest page body while retaining concise action history", () => {
  const messages = render([
    { role: "tool", toolCallId: "1", name: "browser_get_text", result: { text: "OLD".repeat(10_000), pageText: true } },
    { role: "tool", toolCallId: "2", name: "browser_click", result: { text: "Clicked Search" } },
    { role: "tool", toolCallId: "3", name: "browser_get_text", result: { text: "NEW BODY", pageText: true } },
  ])
  const rendered = JSON.stringify(messages)
  expect(rendered).not.toContain("OLD")
  expect(rendered).toContain("older page text omitted")
  expect(rendered).toContain("Clicked Search")
  expect(rendered).toContain("NEW BODY")
})

it("bounds model requests even when an adapter ignores abort", async () => {
  const browser = new BrowserSession({ headless: true })
  const result = await runAgent({ browser, task: "t", timeoutMs: 25, model: { name: "hung", complete: () => new Promise(() => {}) } })
  expect(result).toMatchObject({ status: "failed", stopReason: "timeout", steps: 1 })
  expect(result.durationMs).toBeLessThan(1_000)
  expect(browser.started).toBe(false)
})

it("does not start a pre-cancelled task", async () => {
  const model = scriptedModel([])
  const browser = new BrowserSession({ headless: true })
  const result = await runAgent({ browser, model, task: "t", signal: AbortSignal.abort(new Error("cancelled")) })
  expect(result.stopReason).toBe("cancelled")
  expect(model.requests).toHaveLength(0)
})

it("stops identical successful actions, but permits waits, scrolls and changing states", async () => {
  for (const mode of ["repeat", "wait", "scroll", "changing"]) {
    let count = 0
    const name = mode === "wait" ? "browser_wait_for" : mode === "scroll" ? "browser_scroll" : "browser_click"
    const tool: BrowserTool = { name, description: "test", schema: z.object({}), readOnly: false, capability: "core", async run() {
      return { text: "ok", snapshot: mode === "changing" ? `state ${count++}` : "unchanged state" }
    } }
    const action = () => ({ toolCalls: [{ id: "call", name, arguments: {} }] })
    const model = scriptedModel([action, action, action, () => ({ text: "done", toolCalls: [] })])
    const browser = new BrowserSession({ headless: true })
    const result = await runAgent({ browser, model, task: "t", tools: [tool] })
    expect(result.stopReason).toBe(mode === "repeat" ? "no_progress" : "final_answer")
  }
})

it("cancels an in-flight browser wait and allows a fresh session afterward", async () => {
  const fixture = startFixtureServer()
  const browser = new BrowserSession({ headless: true })
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await (await browser.page()).goto(fixture.url)
    const result = await runAgent({ browser, task: "t", signal: controller.signal,
      model: scriptedModel([() => ({ text: "Read the home page; still waiting", toolCalls: [{ id: "1", name: "browser_wait_for", arguments: { seconds: 30 } }] })]),
      onEvent(event) { if (event.type === "model") timer = setTimeout(() => controller.abort(new Error("stop")), 50) },
    })
    expect(result).toMatchObject({ stopReason: "cancelled", answer: "Read the home page; still waiting" })
    expect(result.durationMs).toBeLessThan(3_000)
    expect(browser.started).toBe(false)
    await (await browser.page()).goto(fixture.url)
    expect(await browser.snapshot()).toContain("Fixture Home")
  } finally { clearTimeout(timer); await browser.close(); fixture.stop() }
}, 30_000)

it("does not leak a browser when cancellation arrives during launch", async () => {
  const browser = new BrowserSession({ headless: true })
  try {
    const opening = browser.page()
    await browser.cancelPending(opening)
    expect(browser.started).toBe(false)
    await browser.page()
    expect(browser.started).toBe(true)
  } finally { await browser.close() }
}, 30_000)

it("handles MCP cancellation outside the queue, including queued tasks, and recovers", async () => {
  let started!: () => void
  const entered = new Promise<void>(resolve => { started = resolve })
  let requests = 0
  let firstSignal: AbortSignal | undefined
  const browser = new BrowserSession({ headless: true })
  const server = createMcpServer({ session: browser, tools: selectTools(), agentModel: {
    name: "cancel-test", async complete(request) {
      requests++
      if (requests === 1) { firstSignal = request.signal; started(); return new Promise(() => {}) }
      return { text: "next task", toolCalls: [] }
    },
  } })
  const call = (id: number) => server.handle({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "browser_task", arguments: { task: "t" } } })
  const first = call(1)
  await entered
  const queued = call(2)
  await server.handle({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 2 } })
  await server.handle({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 1 } })
  expect(firstSignal?.aborted).toBe(true)
  for (const response of await Promise.all([first, queued])) {
    expect((response?.result as any).structuredContent.stopReason).toBe("cancelled")
    expect((response?.result as any).isError).toBe(true)
  }
  expect(requests).toBe(1)
  const next = await call(3)
  expect((next?.result as any).structuredContent.answer).toBe("next task")
  expect(requests).toBe(2)
  await browser.close()
})

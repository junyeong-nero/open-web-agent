import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test"
import { runAgent, type AgentEvent } from "./agent"
import { BrowserSession } from "./browser"
import { refFor, startFixtureServer } from "./testing/fixture"
import { lastToolText, scriptedModel } from "./testing/scripted-model"

const fixture = startFixtureServer()
let session: BrowserSession

beforeEach(() => {
  session = new BrowserSession({ headless: true })
})
afterEach(async () => { await session.close() })
afterAll(() => { fixture.stop() })

describe("runAgent", () => {
  it("drives the browser with tool calls and returns the final text", async () => {
    const model = scriptedModel([
      () => ({ toolCalls: [{ id: "1", name: "browser_navigate", arguments: { url: `${fixture.url}/` } }], usage: { inputTokens: 3, outputTokens: 1 } }),
      (request) => ({
        text: "Opening pricing",
        toolCalls: [{ id: "2", name: "browser_click", arguments: { ref: refFor(lastToolText(request.messages), /link "Pricing" \[/) } }],
      }),
      () => ({ toolCalls: [{ id: "3", name: "browser_get_text", arguments: {} }] }),
      (request) => ({ text: `The Pro plan is ${lastToolText(request.messages).match(/\$\d+/)?.[0]}.`, toolCalls: [], usage: { inputTokens: 4, outputTokens: 2 } }),
    ])
    const events: AgentEvent[] = []
    const result = await runAgent({ task: "Find the Pro price", model, browser: session, onEvent: (event) => events.push(event) })

    expect(result).toMatchObject({ status: "completed", answer: "The Pro plan is $42.", steps: 4, usage: { inputTokens: 7, outputTokens: 3 } })
    expect(events.filter((event) => event.type === "tool").map((event) => event.type === "tool" && event.call.name)).toEqual([
      "browser_navigate",
      "browser_click",
      "browser_get_text",
    ])

    // Only the newest snapshot stays in context.
    const lastRequest = model.requests.at(-1)?.messages ?? []
    const texts = lastRequest.flatMap((message) => (message.role === "tool" ? message.content.map((part) => (part.type === "text" ? part.text : "")) : []))
    expect(texts.filter((text) => text.startsWith("Page URL:"))).toHaveLength(1)
    expect(texts.filter((text) => text.includes("older snapshot omitted"))).toHaveLength(1)
  }, 30_000)

  it("includes the current page when the browser is already open", async () => {
    await (await session.page()).goto(`${fixture.url}/pricing`)
    const model = scriptedModel([() => ({ text: "ok", toolCalls: [] })])
    await runAgent({ task: "t", model, browser: session })
    const first = model.requests[0]?.messages[0]
    expect(first?.role === "user" && first.content[0]?.type === "text" && first.content[0].text).toContain("Page title: Pricing")
  }, 30_000)

  it("stops after repeated failing steps", async () => {
    const failing = () => ({ toolCalls: [{ id: "x", name: "browser_click", arguments: { ref: "nope" } }] })
    const result = await runAgent({ task: "t", model: scriptedModel([failing, failing]), browser: session, maxConsecutiveFailures: 2 })
    expect(result.status).toBe("failed")
    expect(result.steps).toBe(2)
  })

  it("asks for a final answer without tools when out of steps", async () => {
    const model = scriptedModel([
      () => ({ toolCalls: [{ id: "1", name: "browser_snapshot", arguments: {} }] }),
      () => ({ text: "best guess", toolCalls: [] }),
    ])
    const result = await runAgent({ task: "t", model, browser: session, maxSteps: 1 })
    expect(result).toMatchObject({ status: "max_steps", answer: "best guess", steps: 1 })
    expect(model.requests[1]?.tools).toEqual([])
  }, 30_000)
})

it("separates model-reported outcomes from execution and observed URLs", async () => {
  await (await session.page()).goto(`${fixture.url}/pricing`)
  const result = await runAgent({ task: "Read price", browser: session, model: scriptedModel([
    () => ({ text: JSON.stringify({ answer: "Cannot access the price", outcome: "blocked", unfinished: ["Read price"], sources: ["https://invented.invalid"] }), toolCalls: [] }),
  ]) })
  expect(result).toMatchObject({ status: "completed", stopReason: "final_answer", outcome: { status: "blocked", verification: "unverified", unfinished: ["Read price"] } })
  expect(result.observedUrls).toEqual([`${fixture.url}/pricing`])
  expect(result.durationMs).toBeGreaterThanOrEqual(0)
}, 30_000)

it("does not infer success from plain text or malformed structured answers", async () => {
  for (const answer of ["Done", '{"answer":"Done","outcome":"succeeded"}']) {
    const result = await runAgent({ task: "t", browser: session, model: scriptedModel([() => ({ text: answer, toolCalls: [] })]) })
    expect(result.answer).toBe(answer)
    expect(result.outcome.status).toBe("unknown")
  }
})

it("preserves execution metadata when the model request fails", async () => {
  const result = await runAgent({ task: "t", browser: session, model: scriptedModel([() => { throw new Error("HTTP 503") }]) })
  expect(result).toMatchObject({ status: "failed", stopReason: "model_error", error: "HTTP 503", outcome: { status: "unknown" } })
})

it("retains landing URLs and titles after action and explicit snapshots are omitted", async () => {
  const model = scriptedModel([
    () => ({ toolCalls: [{ id: "1", name: "browser_navigate", arguments: { url: `${fixture.url}/redirect` } }] }),
    () => ({ toolCalls: [{ id: "2", name: "browser_snapshot", arguments: {} }] }),
    () => ({ toolCalls: [{ id: "3", name: "browser_navigate", arguments: { url: `${fixture.url}/pricing` } }] }),
    () => ({ text: "ok", toolCalls: [] }),
  ])
  const result = await runAgent({ task: "Read the page", model, browser: session })
  expect(result.status).toBe("completed")
  const messages = model.requests.at(-1)!.messages.filter((message) => message.role === "tool")
  expect(messages).toHaveLength(3)
  for (const message of messages.slice(0, 2)) {
    const text = message.content.map((part) => part.type === "text" ? part.text : "").join("\n")
    expect(text).toContain("older snapshot omitted")
    expect(text).not.toContain("Check you are human")
    const landing = text.split("\n").find((line) => line.startsWith("Landing URL:"))!
    expect(landing).toContain(`Landing URL: ${fixture.url}/sorry?token=`)
    expect(landing).toEndWith("… | Title: Just a moment...")
    expect(landing.length).toBeLessThanOrEqual(303)
    expect(text).not.toContain("x".repeat(400))
  }
  expect(messages[0]!.content[0]).toMatchObject({ type: "text", text: expect.stringContaining(`Navigated to ${fixture.url}/redirect\nLanding URL:`) })
  const newest = messages[2]!.content.map((part) => part.type === "text" ? part.text : "").join("\n")
  expect(newest).toContain(`Landing URL: ${fixture.url}/pricing | Title: Pricing`)
  expect(newest).toContain("Page title: Pricing")
  expect(newest).not.toContain("older snapshot omitted")
}, 30_000)

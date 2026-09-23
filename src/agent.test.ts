import { afterAll, describe, expect, it } from "bun:test"
import { runAgent, type AgentEvent } from "./agent"
import { BrowserSession } from "./browser"
import { refFor, startFixtureServer } from "./testing/fixture"
import { lastToolText, scriptedModel } from "./testing/scripted-model"

const fixture = startFixtureServer()
const session = new BrowserSession({ headless: true })

afterAll(async () => {
  await session.close()
  fixture.stop()
})

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

    expect(result).toEqual({ status: "completed", answer: "The Pro plan is $42.", steps: 4, usage: { inputTokens: 7, outputTokens: 3 } })
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
  })

  it("includes the current page when the browser is already open", async () => {
    const model = scriptedModel([() => ({ text: "ok", toolCalls: [] })])
    await runAgent({ task: "t", model, browser: session })
    const first = model.requests[0]?.messages[0]
    expect(first?.role === "user" && first.content[0]?.type === "text" && first.content[0].text).toContain("Page title: Pricing")
  })

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
  })
})

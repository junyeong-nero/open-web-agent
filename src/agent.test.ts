import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test"
import { runAgent, type AgentEvent } from "./agent"
import { BrowserSession } from "./browser"
import { refFor, startFixtureServer } from "./testing/fixture"
import { lastToolText, scriptedModel } from "./testing/scripted-model"

const clock = { now: new Date("2026-10-09T16:30:00Z"), timeZone: "Asia/Seoul" }
const dateLine = "Today is Saturday, 2026-10-10 (Asia/Seoul)."

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
    const result = await runAgent({ task: "Find the Pro price", model, browser: session, onEvent: (event) => events.push(event), ...clock })

    expect(result).toMatchObject({ status: "completed", answer: "The Pro plan is $42.", steps: 4, usage: { inputTokens: 7, outputTokens: 3 } })
    expect(events.filter((event) => event.type === "tool").map((event) => event.type === "tool" && event.call.name)).toEqual([
      "browser_navigate",
      "browser_click",
      "browser_get_text",
    ])

    expect(model.requests[0]!.messages[0]).toEqual({ role: "user", content: [{ type: "text", text: `${dateLine}\n\nTask: Find the Pro price\n\nThe browser has not opened any page yet.` }] })
    for (const request of model.requests) {
      expect(request.messages[0]).toEqual(model.requests[0]!.messages[0])
    }

    // Only the newest snapshot stays in context.
    const lastRequest = model.requests.at(-1)?.messages ?? []
    const texts = lastRequest.flatMap((message) => (message.role === "tool" ? message.content.map((part) => (part.type === "text" ? part.text : "")) : []))
    expect(texts.filter((text) => text.startsWith("Page URL:"))).toHaveLength(1)
    expect(texts.filter((text) => text.includes("older snapshot omitted"))).toHaveLength(1)
  }, 30_000)

  it("includes the current page when the browser is already open", async () => {
    await (await session.page()).goto(`${fixture.url}/pricing`)
    const model = scriptedModel([() => ({ text: "ok", toolCalls: [] })])
    await runAgent({ task: "t", model, browser: session, ...clock })
    const first = model.requests[0]?.messages[0]
    const text = first?.role === "user" && first.content[0]?.type === "text" && first.content[0].text
    expect(text).toStartWith(`${dateLine}\n\nTask: t\n\nCurrent page:`)
    expect(text).toContain("Page title: Pricing")
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
    expect(model.requests).toHaveLength(2)
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

it("strips citation sequences and orphan delimiters from plain and JSON final answers", async () => {
  const cases = [
    ["… 오피넷의 시도별 평균 기준입니다. \ue200cite\ue202turn0browser_snapshot\ue201", "… 오피넷의 시도별 평균 기준입니다."],
    ["… (5경기 기준) \ue200cite\ue202turn0search0\ue201", "… (5경기 기준)"],
    ["한글🙂\ue200cite\ue202first\ue201 and \ue200cite\ue202second\nref\ue201text \n", "한글🙂 and text"],
    ["한\ue201글\ue202🙂\ue200 trailing \t", "한글🙂 trailing"],
    ["일반 text 🙂 발음은 /ˌserənˈdɪpəti/입니다. Уmore \ue203", "일반 text 🙂 발음은 /ˌserənˈdɪpəti/입니다. Уmore \ue203"],
  ] as const
  for (const [answer, expected] of cases) {
    for (const structured of [false, true]) {
      // Escaped JSON also exercises cleanup after decoding the answer.
      const text = structured
        ? JSON.stringify({ answer, outcome: "succeeded", unfinished: [] }).replace(/[\ue200-\ue202]/g, (char) => `\\u${char.charCodeAt(0).toString(16)}`)
        : answer
      const result = await runAgent({ task: "t", browser: session, model: scriptedModel([() => ({ text, toolCalls: [] })]) })
      expect(result.answer).toBe(expected)
      expect(result.status).toBe("completed")
      expect(result.outcome.status).toBe(structured ? "succeeded" : "unknown")
    }
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

it("gives the model rules for the HTTP statuses that navigation results report", async () => {
  const model = scriptedModel([
    () => ({ toolCalls: [{ id: "1", name: "browser_navigate", arguments: { url: `${fixture.url}/forbidden` } }] }),
    () => ({ toolCalls: [{ id: "2", name: "browser_navigate", arguments: { url: `${fixture.url}/guessed-path` } }] }),
    () => ({ text: 'Blocked\n{"outcome":"blocked","unfinished":["t"]}', toolCalls: [] }),
  ])
  await runAgent({ task: "t", model, browser: session })
  const [, blocked, missing] = model.requests
  expect(lastToolText(blocked!.messages)).toContain("The server responded with HTTP 403.")
  expect(lastToolText(missing!.messages)).toContain("The server responded with HTTP 404.")
  // One assertion per prompt rule, so dropping a rule drops only its line.
  expect(missing!.system).toContain("the server responds with HTTP 401, 402, 403, or 429")
  expect(missing!.system).toContain("If a URL you guessed returns HTTP 404")
  expect(missing!.system).toContain("do not keep rewriting search queries whose results point back to it")
}, 30_000)

it("asks once without tools for an outcome and preserves the original answer", async () => {
  const answer = "The price is $42. https://example.com/pricing"
  const model = scriptedModel([
    () => ({ text: answer, toolCalls: [], usage: { inputTokens: 3, outputTokens: 2 } }),
    (request) => {
      expect(request.tools).toEqual([])
      expect(request.messages.at(-2)).toMatchObject({ role: "assistant", text: answer })
      expect(request.messages.at(-1)).toMatchObject({ role: "user", content: [{ type: "text", text: expect.stringContaining("previous answer") }] })
      return { text: '{"outcome":"partial","unfinished":["Check shipping"]}', toolCalls: [], usage: { inputTokens: 5, outputTokens: 4 } }
    },
  ])
  const events: AgentEvent[] = []
  const result = await runAgent({ task: "t", browser: session, model, maxSteps: 1, onEvent: event => events.push(event) })
  expect(result).toMatchObject({ status: "completed", stopReason: "final_answer", answer, steps: 1, outcome: { status: "partial", unfinished: ["Check shipping"] }, usage: { inputTokens: 8, outputTokens: 6 } })
  expect(model.requests).toHaveLength(2)
  expect(events.filter(event => event.type === "model").map(event => event.step)).toEqual([1, 1])
  expect(events.filter(event => event.type === "step")).toHaveLength(1)
})

it("does not ask again when an outcome is already recognized", async () => {
  const model = scriptedModel([() => ({ text: 'Done\n{"outcome":"succeeded","unfinished":[]}', toolCalls: [] })])
  const result = await runAgent({ task: "t", browser: session, model })
  expect(result.outcome.status).toBe("succeeded")
  expect(model.requests).toHaveLength(1)
})

it("keeps the answer after failed, empty, or unrecognized follow-ups without retrying", async () => {
  for (const text of [undefined, "Still done", "", '{"outcome":"invalid","unfinished":[]}']) {
    const model = scriptedModel([
      () => ({ text: "Original answer", toolCalls: [] }),
      () => { if (text === undefined) throw new Error("HTTP 503"); return { text, toolCalls: [] } },
    ])
    const result = await runAgent({ task: "t", browser: session, model })
    expect(result).toMatchObject({ status: "completed", stopReason: "final_answer", answer: "Original answer", outcome: { status: "unknown", unfinished: [] } })
    expect(result.error).toBeUndefined()
    expect(model.requests).toHaveLength(2)
  }
})

it("takes only outcome fields even when the follow-up rewrites the answer", async () => {
  const model = scriptedModel([
    () => ({ text: "Original answer", toolCalls: [] }),
    () => ({ text: '{"answer":"","outcome":"blocked","unfinished":["Read price"]}', toolCalls: [] }),
  ])
  const result = await runAgent({ task: "t", browser: session, model })
  expect(result).toMatchObject({ answer: "Original answer", outcome: { status: "blocked", unfinished: ["Read price"] } })
})

it("bounds the follow-up by the task deadline and cancellation while retaining the answer", async () => {
  for (const cancel of [false, true]) {
    const controller = new AbortController()
    let followUpSignal: AbortSignal | undefined
    const model = scriptedModel([
      () => ({ text: "Original answer", toolCalls: [] }),
      request => {
        followUpSignal = request.signal
        if (cancel) controller.abort(new Error("Cancelled"))
        // Simulate an adapter that ignores abort; runAgent must stop waiting.
        return new Promise(() => {})
      },
    ])
    const result = await runAgent({ task: "t", browser: session, model, signal: controller.signal, timeoutMs: cancel ? 1000 : 30 })
    expect(followUpSignal?.aborted).toBe(true)
    expect(result).toMatchObject({ status: "completed", answer: "Original answer", steps: 1, outcome: { status: "unknown" } })
    expect(model.requests).toHaveLength(2)
  }
})

it("does not request an outcome after a model error or pre-existing cancellation", async () => {
  for (const cancel of [false, true]) {
    const controller = new AbortController()
    if (cancel) controller.abort()
    const model = scriptedModel([() => { throw new Error("HTTP 503") }])
    const result = await runAgent({ task: "t", browser: session, model, signal: controller.signal })
    expect(result.stopReason).toBe(cancel ? "cancelled" : "model_error")
    expect(model.requests).toHaveLength(cancel ? 0 : 1)
  }
})

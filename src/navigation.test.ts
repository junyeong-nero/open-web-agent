import { afterAll, afterEach, beforeEach, expect, it } from "bun:test"
import { runAgent } from "./agent"
import { BrowserSession } from "./browser"
import { startFixtureServer } from "./testing/fixture"
import { scriptedModel } from "./testing/scripted-model"
import { callTool, selectTools } from "./tools"

const fixture = startFixtureServer()
const tools = selectTools()
let session: BrowserSession

beforeEach(async () => {
  session = new BrowserSession({ headless: true, actionTimeoutMs: 500 })
  // Warm the renderer before measuring the slow response, including on cold Chromium.
  await (await session.page()).goto(fixture.url, { timeout: 20_000 })
  await session.snapshot()
}, 30_000)
afterEach(async () => { await session.close() })
afterAll(() => { fixture.stop() })

it("returns usable refs and a loading notice after a slow document commits, including same-URL reloads", async () => {
  for (let attempt = 0; attempt < 2; attempt++) {
    const started = performance.now()
    const result = await callTool(tools, session, "browser_navigate", { url: `${fixture.url}/slow-body` })
    expect(result.isError).toBeUndefined()
    expect(result.text).toContain("may still be loading")
    expect(result.snapshot).toContain(`Page URL: ${fixture.url}/slow-body`)
    expect(result.snapshot).toMatch(/heading "Usable content".*\[ref=e\d+\]/)
    expect(result.snapshot).not.toContain("Finished loading")
    expect(performance.now() - started).toBeLessThan(3_000)
  }
}, 30_000)

it("returns the committed history page while its body is still loading", async () => {
  await callTool(tools, session, "browser_navigate", { url: `${fixture.url}/slow-body` })
  await callTool(tools, session, "browser_navigate", { url: `${fixture.url}/pricing` })
  const result = await callTool(tools, session, "browser_go_back", {})
  expect(result.isError).toBeUndefined()
  expect(result.text).toContain("may still be loading")
  expect(result.snapshot).toContain("Usable content")
}, 30_000)

it("keeps connection failures and timeouts before commit as errors", async () => {
  const page = await session.page()
  await page.route("**/connection-failure", (route) => route.abort("connectionrefused"))
  await page.route("**/no-response", () => {})
  for (const path of ["connection-failure", "no-response"]) {
    const result = await callTool(tools, session, "browser_navigate", { url: `${fixture.url}/${path}` })
    expect(result.isError).toBe(true)
    expect(result.snapshot).toBeUndefined()
    expect(result.text).not.toContain("may still be loading")
  }
}, 30_000)

it("reports HTTP error statuses while still returning the error page, including after going back", async () => {
  const result = await callTool(tools, session, "browser_navigate", { url: `${fixture.url}/forbidden` })
  expect(result.isError).toBeUndefined()
  expect(result.text).toContain("HTTP 403")
  expect(result.snapshot).toContain("Access denied")
  expect((await callTool(tools, session, "browser_navigate", { url: `${fixture.url}/pricing` })).text).not.toContain("HTTP")
  const back = await callTool(tools, session, "browser_go_back", {})
  expect(back.isError).toBeUndefined()
  expect(back.text).toContain("HTTP 403")
  expect(back.snapshot).toContain("Access denied")
}, 30_000)

it("waits and reloads a rate-limited page once, returning the recovered page", async () => {
  const started = performance.now()
  const result = await callTool(tools, session, "browser_navigate", { url: `${fixture.url}/rate-limit?recover` })
  expect(result.isError).toBeUndefined()
  expect(result.snapshot).toContain("Page title: Recovered")
  expect(result.snapshot).toContain("Request 2")
  expect(result.text).toContain("The first response was HTTP 429; the browser waited 1 s and reloaded once.")
  expect(result.text).not.toContain("The server responded with HTTP 429.")
  expect(performance.now() - started).toBeGreaterThanOrEqual(1_000)
}, 30_000)

it("reports a persistent rate limit after exactly one reload, including history navigation", async () => {
  const page = await session.page()
  let requests = 0
  page.on("request", (request) => {
    if (request.isNavigationRequest() && request.url().includes("/rate-limit")) requests++
  })
  const result = await callTool(tools, session, "browser_navigate", { url: `${fixture.url}/rate-limit?always` })
  expect(requests).toBe(2)
  await callTool(tools, session, "browser_navigate", { url: `${fixture.url}/pricing` })
  requests = 0
  const back = await callTool(tools, session, "browser_go_back", {})
  expect(requests).toBe(2)
  for (const response of [result, back]) {
    expect(response.isError).toBeUndefined()
    expect(response.text).toContain("The server responded with HTTP 429.")
    expect(response.text).toContain("The site is rate-limiting this browser and may be blocking it; it still answered HTTP 429 after waiting 1 s and one reload.")
    expect(response.snapshot).toContain("Too many requests")
  }
}, 30_000)

it("handles downloads and still-loading pages during the automatic reload", async () => {
  const download = await callTool(tools, session, "browser_navigate", { url: `${fixture.url}/rate-limit?then=/blank-file` })
  expect(download.isError).toBe(true)
  expect(download.text).toContain("waited 1 s and reloaded once")
  expect(download.text).toContain("This counts as a block under the rules; use another site.")
  const slow = await callTool(tools, session, "browser_navigate", { url: `${fixture.url}/rate-limit?then=/slow-body` })
  expect(slow.isError).toBeUndefined()
  expect(slow.text).toContain("waited 1 s and reloaded once")
  expect(slow.text).toContain("may still be loading")
  expect(slow.snapshot).toContain("Usable content")
}, 30_000)

it("treats a non-document attachment as a site block", async () => {
  const result = await callTool(tools, session, "browser_navigate", { url: `${fixture.url}/blank-file` })
  expect(result.isError).toBe(true)
  expect(result.text).toContain("non-document file (content-type `application/blank`, filename `response`) instead of a page")
  expect(result.text).toContain("other URLs on the same site will likely do the same.")
  expect(result.text).toContain("This counts as a block under the rules; use another site.")
})

it("explains navigations that download a file instead of opening a page", async () => {
  const result = await callTool(tools, session, "browser_navigate", { url: `${fixture.url}/paper` })
  expect(result.isError).toBe(true)
  expect(result.text).toContain("content-type `application/pdf`, filename `paper.pdf`")
  expect(result.text).toContain("Opening the same URL again gives the same result")
  expect(result.text).toContain("HTML version")

  // A history entry that now answers with a file fails the same way.
  await callTool(tools, session, "browser_navigate", { url: `${fixture.url}/pricing` })
  await callTool(tools, session, "browser_navigate", { url: fixture.url })
  await (await session.page()).route("**/pricing", (route) => route.fulfill({
    contentType: "text/csv", headers: { "content-disposition": 'attachment; filename="prices.csv"' }, body: "plan,price",
  }))
  const back = await callTool(tools, session, "browser_go_back", {})
  expect(back.isError).toBe(true)
  expect(back.text).toContain("content-type `text/csv`, filename `prices.csv`")
  expect(back.text).not.toContain("HTML version")
}, 30_000)

for (const stopReason of ["timeout", "cancelled"] as const) {
  it(`preserves task ${stopReason} during a committed slow navigation`, async () => {
    const controller = new AbortController()
    const page = await session.page()
    let committed = false
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame() && frame.url().endsWith("/slow-body")) {
        committed = true
        if (stopReason === "cancelled") controller.abort(new Error("Cancelled by test"))
      }
    })
    session.options.actionTimeoutMs = 10_000
    const model = scriptedModel([
      () => ({ toolCalls: [{ id: "1", name: "browser_navigate", arguments: { url: `${fixture.url}/slow-body` } }] }),
    ])
    const result = await runAgent({
      browser: session, model, task: "Open the slow page", signal: controller.signal,
      timeoutMs: stopReason === "timeout" ? 1_000 : 10_000,
    })
    expect(committed).toBe(true)
    expect(result.stopReason).toBe(stopReason)
    expect(model.requests).toHaveLength(1)
    expect(session.started).toBe(false)
  }, 30_000)
}

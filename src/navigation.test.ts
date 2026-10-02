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

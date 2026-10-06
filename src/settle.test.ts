import { afterAll, beforeAll, beforeEach, expect, it } from "bun:test"
import { runAgent } from "./agent"
import { BrowserSession } from "./browser"
import { refFor, startFixtureServer } from "./testing/fixture"
import { scriptedModel } from "./testing/scripted-model"
import { callTool, selectTools } from "./tools"

const fixture = startFixtureServer()
const session = new BrowserSession({ headless: true })
const call = (name: string, args: Record<string, unknown> = {}) => callTool(selectTools(), session, name, args)
const changing = "The page may still be changing."

async function timed(name: string, args: Record<string, unknown>) {
  const started = performance.now()
  const result = await call(name, args)
  return { result, ms: performance.now() - started }
}

/** Open the home page with a link to `path`, and return the link's ref. */
async function linkTo(path: string): Promise<string> {
  await call("browser_navigate", { url: fixture.url })
  await (await session.page()).evaluate((path) => document.body.insertAdjacentHTML("beforeend", `<a href="${path}">Continue</a>`), path)
  return refFor((await call("browser_snapshot")).snapshot!, /link "Continue"/)
}

beforeAll(async () => {
  // A new renderer can stall about 2 s on its first text render; time nothing before it has rendered once.
  await call("browser_navigate", { url: fixture.url })
}, 30_000)
beforeEach(() => { session.options.settleTimeoutMs = undefined })
afterAll(async () => {
  await session.close()
  fixture.stop()
})

it("waits for a list rendered after DOMContentLoaded", async () => {
  session.options.settleTimeoutMs = 0
  expect((await call("browser_navigate", { url: `${fixture.url}/late-list` })).snapshot).not.toContain("Result one")

  session.options.settleTimeoutMs = undefined
  const result = await call("browser_navigate", { url: `${fixture.url}/late-list` })
  expect(result.isError).toBeUndefined()
  expect(result.text).not.toContain(changing)
  expect(result.snapshot).toContain("Result two")
}, 30_000)

it("waits for results that a click fetches", async () => {
  const { snapshot } = await call("browser_navigate", { url: `${fixture.url}/late-fetch` })
  const result = await call("browser_click", { ref: refFor(snapshot!, /button "Search"/) })
  expect(result.isError).toBeUndefined()
  expect(result.text).not.toContain(changing)
  expect(result.snapshot).toContain("Found 3 results")
}, 30_000)

it("returns refs that survive a late URL change and re-render", async () => {
  session.options.settleTimeoutMs = 0
  const early = await call("browser_navigate", { url: `${fixture.url}/late-redirect` })
  await (await session.page()).waitForURL(/rdr=1/)
  const stale = await call("browser_type", { ref: refFor(early.snapshot!, /textbox "Query"/), text: "shoes" })
  expect(stale.isError).toBe(true)
  expect(stale.text).toContain("is no longer on the page")

  session.options.settleTimeoutMs = undefined
  const result = await call("browser_navigate", { url: `${fixture.url}/late-redirect` })
  expect(result.snapshot).toContain(`Page URL: ${fixture.url}/late-redirect?rdr=1\n`)
  const typed = await call("browser_type", { ref: refFor(result.snapshot!, /textbox "Query"/), text: "shoes" })
  expect(typed.isError).toBeUndefined()
  expect(await (await session.page()).locator("input").inputValue()).toBe("shoes")
}, 30_000)

it.each([
  ["browser_navigate", async () => ({ url: `${fixture.url}/interstitial` })],
  ["browser_click", async () => ({ ref: await linkTo("/interstitial") })],
] as const)("returns the final page of a client-side redirect after %s", async (name, args) => {
  const result = await call(name, await args())
  expect(result.isError).toBeUndefined()
  expect(result.snapshot).toContain(`Page URL: ${fixture.url}/pricing\n`)
  expect(result.snapshot).toContain("The Pro plan costs $42 per month.")
}, 30_000)

it("waits for a navigation that commits after the click's navigation window", async () => {
  const result = await call("browser_click", { ref: await linkTo("/slow-page") })
  expect(result.isError).toBeUndefined()
  expect(result.snapshot).toContain("Page title: Slow results")
}, 30_000)

it("returns within the cap, with a note, from a page that never settles", async () => {
  const opened = await timed("browser_navigate", { url: `${fixture.url}/never-settles` })
  expect(opened.result.isError).toBeUndefined()
  expect(opened.result.text).toContain(changing)
  expect(opened.result.snapshot).toContain("Live ticker")
  expect(opened.ms).toBeGreaterThanOrEqual(3_000)
  expect(opened.ms).toBeLessThan(4_500)

  const clicked = await timed("browser_click", { ref: refFor(opened.result.snapshot!, /button "Refresh"/) })
  expect(clicked.result.isError).toBeUndefined()
  expect(clicked.result.text).toStartWith(`Clicked ${refFor(opened.result.snapshot!, /button "Refresh"/)}\n${changing}\n`)
  expect(clicked.ms).toBeLessThan(5_000)
}, 30_000)

it("stops waiting as soon as the task is cancelled", async () => {
  // Cancelling closes the browser, so use a session of its own.
  const browser = new BrowserSession({ headless: true })
  try {
    const page = await browser.page()
    await page.goto(fixture.url)
    await browser.snapshot()
    const controller = new AbortController()
    page.on("load", () => setTimeout(() => controller.abort(new Error("Cancelled by test")), 300))
    const model = scriptedModel([() => ({ toolCalls: [{ id: "1", name: "browser_navigate", arguments: { url: `${fixture.url}/never-settles` } }] })])
    const started = performance.now()
    const result = await runAgent({ browser, model, task: "Watch the ticker", signal: controller.signal })
    expect(result.stopReason).toBe("cancelled")
    expect(performance.now() - started).toBeLessThan(2_000)
    expect(browser.started).toBe(false)
  } finally { await browser.close() }
}, 30_000)

it("adds little delay on static pages", async () => {
  const navigated = await timed("browser_navigate", { url: `${fixture.url}/pricing` })
  expect(navigated.result.text).not.toContain(changing)
  expect(navigated.ms).toBeLessThan(1_500)

  const { snapshot } = await call("browser_navigate", { url: fixture.url })
  const clicked = await timed("browser_click", { ref: refFor(snapshot!, /button "Search"/) })
  expect(clicked.result.text).not.toContain(changing)
  expect(clicked.result.snapshot).toContain("Searched")
  expect(clicked.ms).toBeLessThan(1_500)
}, 30_000)

it("does not wait for event streams, beacons, or requests started before the action", async () => {
  const opened = await timed("browser_navigate", { url: `${fixture.url}/live-connections` })
  expect(opened.result.text).not.toContain(changing)
  expect(opened.ms).toBeLessThan(1_500)

  // A long poll the page already had open; the click then sends a beacon. Both take 2.5 s to answer.
  await (await session.page()).evaluate(() => { void fetch("/slow-ack") })
  const saved = await timed("browser_click", { ref: refFor(opened.result.snapshot!, /button "Save"/) })
  expect(saved.result.snapshot).toContain("Saved")
  expect(saved.result.text).not.toContain(changing)
  expect(saved.ms).toBeLessThan(1_500)
}, 30_000)

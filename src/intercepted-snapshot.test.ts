import { afterAll, expect, it } from "bun:test"
import type { Page } from "playwright"
import { BrowserSession } from "./browser"
import { refFor, startFixtureServer } from "./testing/fixture"
import { callTool, selectTools } from "./tools"

const fixture = startFixtureServer()
const tools = selectTools()
// Keep the default action timeout for navigation and the first snapshot, since a new renderer can stall about 2 s on its
// first text render. Only the intercepted click gets a short one.
const session = new BrowserSession({ headless: true })
const covered = "Another element covers the target. The snapshot in this result shows the current page, and its refs are current; use it to deal with the covering element, such as a dialog, popup or banner, before retrying."
const guidance = "Take a new browser_snapshot if the page may have changed."
const call = (name: string, args: Record<string, unknown>) => callTool(tools, session, name, args)

afterAll(async () => {
  await session.close()
  fixture.stop()
})

it("returns the current snapshot when a late overlay intercepts a click, and its refs close the overlay", async () => {
  const { snapshot = "" } = await call("browser_navigate", { url: `${fixture.url}/late-overlay` })
  const buy = refFor(snapshot, /button "Buy now"/)
  // The overlay opens after the click's own snapshot, so the model still sees the button uncovered.
  const first = await call("browser_click", { ref: buy })
  expect(first.isError).toBeUndefined()
  expect(first.snapshot).not.toContain('dialog "Sign in"')
  const page = await session.page()
  await page.getByRole("dialog").waitFor()

  page.setDefaultTimeout(1_500)
  const result = await call("browser_click", { ref: buy }).finally(() => page.setDefaultTimeout(10_000))
  expect(result.isError).toBe(true)
  expect(result.text).toStartWith("browser_click failed: click: Timeout 1500ms exceeded.\n")
  expect(result.text).toContain(` intercepts pointer events\n${covered}\nLanding URL: ${fixture.url}/late-overlay | Title: Late overlay`)
  expect(result.text).not.toContain(guidance)
  expect(result.snapshot).toContain('dialog "Sign in"')
  expect(result.snapshot).toContain('heading "Sign in for member prices"')

  const closed = await call("browser_click", { ref: refFor(result.snapshot!, /button "Close"/) })
  expect(closed.isError).toBeUndefined()
  expect(closed.snapshot).not.toContain('dialog "Sign in"')
  expect(await page.getByRole("dialog").count()).toBe(0)
}, 30_000)

/** Playwright's click timeout, as in tool-errors.test.ts, with the call log's last reason. */
const clickTimeout = (reason: string) => new Error(`click: Timeout 10000ms exceeded.\nCall log:\n  - waiting for locator('aria-ref=e2')\n  - locator resolved to <button>Buy now</button>\n  - ${reason}\n`)
const interception = clickTimeout('<div role="dialog" aria-label="Sign in">…</div> intercepts pointer events')
const interceptionReason = "click: Timeout 10000ms exceeded.\n- waiting for locator('aria-ref=e2')\n- locator resolved to <button>Buy now</button>\n- <div role=\"dialog\" aria-label=\"Sign in\">…</div> intercepts pointer events"
const checkout = "Page URL: https://shop.test/checkout\nPage title: Checkout\nPage tab: t1\nSnapshot:\n- dialog \"Sign in\" [ref=e5]:\n  - button \"Close\" [ref=e6]\n- button \"Buy now\" [ref=e2]"

/** A session without a browser: clicking e2 fails with `error`, and `snapshot` stands in for the page snapshot. */
function stubSession(error: Error, snapshot: () => Promise<string>) {
  const stub = new BrowserSession()
  const calls = { snapshots: 0 }
  const target = { count: async () => 1, click: async () => { throw error } }
  stub.page = async () => ({ waitForEvent: async () => { throw new Error("No navigation") }, locator: () => target }) as unknown as Page
  stub.snapshot = async () => {
    calls.snapshots++
    return snapshot()
  }
  return { stub, calls }
}

it("keeps the reason and replaces the hint when it returns the snapshot", async () => {
  const { stub, calls } = stubSession(interception, async () => checkout)
  expect(await callTool(tools, stub, "browser_click", { ref: "e2" })).toStrictEqual({
    text: `browser_click failed: ${interceptionReason}\n${covered}\nLanding URL: https://shop.test/checkout | Title: Checkout`,
    snapshot: checkout,
    isError: true,
  })
  expect(calls.snapshots).toBe(1)
})

it("returns the interception exactly as before when its snapshot fails too", async () => {
  const { stub, calls } = stubSession(interception, async () => { throw new Error("ariaSnapshot: Timeout 10000ms exceeded.") })
  expect(await callTool(tools, stub, "browser_click", { ref: "e2" })).toStrictEqual({
    text: `browser_click failed: ${interceptionReason}\n${guidance}`,
    isError: true,
  })
  expect(calls.snapshots).toBe(1)
})

it.each([
  ["a malformed ref", "browser_click", { ref: "#go" }, `browser_click failed: "#go" is not a snapshot ref (expected e.g. "e12"). Take a browser_snapshot and use a [ref=…] value.\n${guidance}`],
  ["a timeout without an interception", "browser_click", { ref: "e2" }, `browser_click failed: click: Timeout 10000ms exceeded.\n- waiting for locator('aria-ref=e2')\n- locator resolved to <button>Buy now</button>\n- element is not enabled\n${guidance}`],
  ["an unknown tool", "browser_nope", {}, 'Unknown tool "browser_nope"'],
  ["invalid arguments", "browser_click", {}, "Invalid arguments for browser_click: ✖ Invalid input: expected string, received undefined\n  → at ref"],
] as const)("keeps %s as before, without a snapshot", async (_, name, args, text) => {
  const { stub, calls } = stubSession(clickTimeout("element is not enabled"), async () => checkout)
  expect(await callTool(tools, stub, name, args)).toStrictEqual({ text, isError: true })
  expect(calls.snapshots).toBe(0)
})

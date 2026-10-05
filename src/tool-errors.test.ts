import { afterAll, expect, it } from "bun:test"
import type { Locator, Page } from "playwright"
import { BrowserSession } from "./browser"
import { refFor, startFixtureServer } from "./testing/fixture"
import { callTool, selectTools } from "./tools"

const fixture = startFixtureServer()
const tools = selectTools()
const guidance = "Take a new browser_snapshot if the page may have changed."

afterAll(() => { fixture.stop() })

/** A Playwright click timeout: each retry logs its reason again, and every call log line is dimmed with ANSI codes. */
function clickTimeout(reasons: string[]): Error {
  const retries = reasons.flatMap((reason) => [
    "    2 × waiting for element to be visible, enabled and stable",
    "      - element is visible, enabled and stable",
    "      - scrolling into view if needed",
    "      - done scrolling",
    `      - ${reason}`,
    "    - retrying click action",
    "      - waiting 100ms",
  ])
  const log = ["  - waiting for locator('aria-ref=e2')", "    - locator resolved to <button>Buy now</button>", "  - attempting click action", ...retries]
  return new Error(`click: Timeout 10000ms exceeded.\nCall log:\n${log.map((line) => `\u001b[2m${line}\u001b[22m`).join("\n")}\n`)
}

/** Click e2 in a session whose click throws `error`, without launching a browser. */
function clickFailingWith(error: Error) {
  const session = new BrowserSession()
  session.page = async () => ({ waitForEvent: async () => { throw new Error("No navigation") } }) as unknown as Page
  session.locator = async () => ({ click: async () => { throw error } }) as unknown as Locator
  return callTool(tools, session, "browser_click", { ref: "e2" })
}

it("names the element that intercepts a click", async () => {
  const session = new BrowserSession({ headless: true })
  try {
    // Load and snapshot with the default timeout, since a new renderer can stall about 2 s on its first text render.
    // Only the click gets the short timeout.
    const page = await session.page()
    await page.goto(`${fixture.url}/overlay`)
    const ref = refFor(await session.snapshot(), /button "Buy now"/)
    page.setDefaultTimeout(1_000)
    const result = await callTool(tools, session, "browser_click", { ref })
    expect(result.isError).toBe(true)
    expect(result.text).toStartWith("browser_click failed: click: Timeout 1000ms exceeded.\n")
    expect(result.text).toContain("\n- locator resolved to <button>Buy now</button>\n")
    expect(result.text).toContain('\n- <div id="overlay"></div> intercepts pointer events\n')
    expect(result.text.match(/intercepts pointer events/g)).toHaveLength(1)
    expect(result.text).not.toContain("retrying click action")
    expect(result.text).not.toContain("\u001b[")
    expect(result.text).toEndWith(`\n${guidance}`)
  } finally { await session.close() }
}, 30_000)

it("keeps each reason once, in order, without the retry narration", async () => {
  const intercepted = '<div id="overlay"></div> intercepts pointer events'
  const result = await clickFailingWith(clickTimeout(["element is not stable", "element is not stable", intercepted, intercepted]))
  expect(result.isError).toBe(true)
  expect(result.text).toBe([
    "browser_click failed: click: Timeout 10000ms exceeded.",
    "- waiting for locator('aria-ref=e2')",
    "- locator resolved to <button>Buy now</button>",
    "- element is not stable",
    `- ${intercepted}`,
    guidance,
  ].join("\n"))
})

it("bounds long reasons but keeps the first line, the interception, and the guidance", async () => {
  const backdrop = (index: number) => `<div id="backdrop-${index}" class="${"fixed inset-0 bg-black/80 ".repeat(20)}"></div> intercepts pointer events`
  const result = await clickFailingWith(clickTimeout([0, 1, 2, 3].map(backdrop)))
  const lines = result.text.split("\n")
  expect(lines[0]).toBe("browser_click failed: click: Timeout 10000ms exceeded.")
  // Long element previews are shortened in the middle, so the start of the element and the reason both survive.
  expect(lines[3]).toStartWith('- <div id="backdrop-0" class="fixed inset-0 bg-black/80')
  expect(lines[3]).toContain("…")
  expect(lines[3]).toEndWith('"></div> intercepts pointer events')
  expect(lines[3].length).toBeLessThanOrEqual(202)
  expect(lines.at(-2)).toEndWith("…")
  expect(lines.at(-1)).toBe(guidance)
  expect(result.text.length).toBeLessThanOrEqual("browser_click failed: ".length + 600 + guidance.length + 1)
})

it("keeps a message without a call log intact", async () => {
  const message = [
    "browserType.launch: Executable doesn't exist at /cache/ms-playwright/chromium/chrome",
    "╔════════════════════════════════════════════════════════════╗",
    "║ Looks like Playwright was just installed or updated.       ║",
    "║ Please run the following command to download new browsers: ║",
    "║     npx playwright install                                 ║",
    "╚════════════════════════════════════════════════════════════╝",
  ].join("\n")
  expect((await clickFailingWith(new Error(message))).text).toBe(`browser_click failed: ${message}\n${guidance}`)
})

it("summarizes a failed follow-up snapshot the same way", async () => {
  const session = new BrowserSession()
  session.selectTab = async () => {}
  session.snapshot = async () => { throw clickTimeout(["element is not visible", "element is not visible"]) }
  const result = await callTool(tools, session, "browser_select_tab", { tabId: "t1" })
  expect(result.isError).toBeUndefined()
  expect(result.text).toBe([
    "Selected tab t1",
    "The browser action completed, but its follow-up snapshot failed: click: Timeout 10000ms exceeded.",
    "- waiting for locator('aria-ref=e2')",
    "- locator resolved to <button>Buy now</button>",
    "- element is not visible",
    "Do not repeat the action just to recover the snapshot. Call browser_snapshot to inspect the current page before taking another action.",
  ].join("\n"))
})

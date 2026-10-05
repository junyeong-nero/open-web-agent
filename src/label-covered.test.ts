import { afterAll, beforeEach, expect, it } from "bun:test"
import type { Locator, Page } from "playwright"
import { BrowserSession } from "./browser"
import { refFor, startFixtureServer } from "./testing/fixture"
import { callTool, selectTools } from "./tools"

const fixture = startFixtureServer()
// Keep the default 10-second action timeout so that waiting on an intercepted click fails the timing checks.
const session = new BrowserSession({ headless: true })
const call = (name: string, args: Record<string, unknown> = {}) => callTool(selectTools(), session, name, args)
let snapshot = ""

beforeEach(async () => {
  snapshot = (await call("browser_navigate", { url: `${fixture.url}/toggles` })).snapshot!
}, 30_000)

afterAll(async () => {
  await session.close()
  fixture.stop()
})

/** Click a ref, and measure how long after the call the page recorded its first change event. */
async function clickAndTime(ref: string) {
  const started = Date.now()
  const result = await call("browser_click", { ref })
  // getAttribute, unlike page.evaluate, also works on a page that replaces window.eval.
  const changedAt = await (await session.page()).locator("html").getAttribute("data-changed-at")
  return { result, changedAfter: Number(changedAt ?? NaN) - started }
}

it("clicks a checkbox through the label that covers it within a second", async () => {
  const page = await session.page()
  // Start with the checkbox scrolled out of view, as further down a long list.
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
  const ref = refFor(snapshot, /checkbox "Add to compare"/)
  const { result, changedAfter } = await clickAndTime(ref)
  expect(changedAfter).toBeLessThan(1_000)
  expect(result.isError).toBeUndefined()
  expect(result.text).toStartWith(`Clicked ${ref} through its label "Add to compare", which covers it\n`)
  expect(result.snapshot).toMatch(/checkbox "Add to compare" \[checked\]/)
  expect(await page.locator("#compare").isChecked()).toBe(true)
}, 30_000)

it("clicks a radio through the label that covers it, and a radio that nothing covers as before", async () => {
  const page = await session.page()
  const express = refFor(snapshot, /radio "Express shipping"/)
  const { result, changedAfter } = await clickAndTime(express)
  expect(changedAfter).toBeLessThan(1_000)
  expect(result.isError).toBeUndefined()
  expect(result.text).toStartWith(`Clicked ${express} through its label "Express shipping", which covers it\n`)
  expect(await page.locator("#express").isChecked()).toBe(true)

  const standard = refFor(result.snapshot!, /radio "Standard shipping"/)
  const direct = await call("browser_click", { ref: standard })
  expect(direct.isError).toBeUndefined()
  expect(direct.text).toStartWith(`Clicked ${standard}\n`)
  expect(await page.locator("#standard").isChecked()).toBe(true)
}, 30_000)

it("clicks through the label, and an uncovered checkbox as before, on a page that replaces window.eval", async () => {
  const { snapshot = "" } = await call("browser_navigate", { url: `${fixture.url}/toggles-no-eval` })
  const page = await session.page()
  // As on americanexpress.com, Playwright's page-world evaluate fails here.
  await expect(page.evaluate(() => 1)).rejects.toThrow("eval is disabled")
  const compare = refFor(snapshot, /checkbox "Add to compare"/)
  const { result, changedAfter } = await clickAndTime(compare)
  expect(changedAfter).toBeLessThan(1_000)
  expect(result.isError).toBeUndefined()
  expect(result.text).toStartWith(`Clicked ${compare} through its label "Add to compare", which covers it\n`)
  expect(await page.locator("#compare").isChecked()).toBe(true)

  const updates = refFor(result.snapshot!, /checkbox "Email me card offers"/)
  const direct = await call("browser_click", { ref: updates })
  expect(direct.isError).toBeUndefined()
  expect(direct.text).toStartWith(`Clicked ${updates}\n`)
  expect(await page.locator("#updates").isChecked()).toBe(true)
}, 30_000)

it.each([
  {
    covering: "an unrelated overlay",
    name: "Add to compare",
    interceptor: '<div id="overlay"></div>',
    setup: () => document.body.insertAdjacentHTML("beforeend", '<div id="overlay" style="position: fixed; inset: 0"></div>'),
  },
  { covering: "another checkbox's label", name: "Gift wrap", interceptor: '<label for="insurance">Insurance</label>' },
  { covering: "a link inside its label", name: "I accept the terms", interceptor: '<a href="/pricing">I accept the terms</a>' },
])("still fails with the interception when $covering covers the checkbox", async ({ name, interceptor, setup }) => {
  const page = await session.page()
  if (setup) await page.evaluate(setup)
  const ref = refFor(snapshot, new RegExp(`checkbox "${name}"`))
  // Only the click gets the short timeout, since a new renderer can stall about 2 s on its first text render.
  page.setDefaultTimeout(1_000)
  try {
    const result = await call("browser_click", { ref })
    expect(result.isError).toBe(true)
    expect(result.text).toStartWith("browser_click failed: click: Timeout 1000ms exceeded.\n")
    expect(result.text).toContain(`\n- ${interceptor} intercepts pointer events\n`)
  } finally { page.setDefaultTimeout(10_000) }
  // Nothing was clicked through: no checkbox changed and the link was not followed.
  expect(await page.locator("input[type=checkbox]:checked").count()).toBe(0)
  expect(page.url()).toBe(`${fixture.url}/toggles`)
}, 30_000)

it("looks for a covering label only on checkbox and radio refs, and clicks as before when it cannot", async () => {
  const stub = new BrowserSession()
  const calls: string[] = []
  stub.page = async () => ({ waitForEvent: async () => { throw new Error("No navigation") } }) as unknown as Page
  stub.snapshot = async () => "Page URL: about:blank\nSnapshot:"
  stub.lastSnapshot = { page: {} as Page, url: "about:blank", tree: '- button "Buy now" [ref=e2]\n- checkbox "Gift wrap" [ref=e3]' }
  stub.locator = async () => ({
    count: async () => 1,
    click: async (options?: { trial?: boolean }) => { calls.push(options?.trial ? "trial" : "click") },
    getAttribute: async () => {
      calls.push("lookup")
      throw new Error("Unexpected page state")
    },
  }) as unknown as Locator
  expect((await callTool(selectTools(), stub, "browser_click", { ref: "e2" })).text).toBe("Clicked e2")
  expect(calls).toEqual(["click"])
  // When a step of the check fails, the checkbox gets the normal click instead of an error.
  expect((await callTool(selectTools(), stub, "browser_click", { ref: "e3" })).text).toBe("Clicked e3")
  expect(calls).toEqual(["click", "lookup", "click"])
})

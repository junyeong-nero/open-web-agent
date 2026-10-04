import { afterAll, beforeEach, expect, it } from "bun:test"
import { BrowserSession } from "./browser"
import { refFor, startFixtureServer } from "./testing/fixture"
import { callTool, selectTools } from "./tools"

const fixture = startFixtureServer()
// Keep the default 10-second action timeout so that waiting on a missing element fails the timing checks.
const session = new BrowserSession({ headless: true })
const call = (name: string, args: Record<string, unknown> = {}) => callTool(selectTools(), session, name, args)
let snapshot = ""

beforeEach(async () => {
  snapshot = (await call("browser_navigate", { url: `${fixture.url}/` })).snapshot!
}, 30_000)

afterAll(async () => {
  await session.close()
  fixture.stop()
})

it("clicks the identical element that replaced a stale ref within a second", async () => {
  const page = await session.page()
  const stale = refFor(snapshot, /button "Search"/)
  // Hydration swaps server-rendered nodes for identical new ones after the snapshot.
  await page.evaluate(() => {
    const button = document.querySelector("#go")!
    button.replaceWith(button.cloneNode(true))
    document.addEventListener("click", () => { (window as any).clickedAt = Date.now() })
  })
  const started = Date.now()
  const result = await call("browser_click", { ref: stale })
  expect(await page.evaluate(() => (window as any).clickedAt) - started).toBeLessThan(1_000)
  expect(result.isError).toBeUndefined()
  const fresh = refFor(result.snapshot!, /button "Search"/)
  expect(fresh).not.toBe(stale)
  expect(result.text).toStartWith(`ref ${stale} was stale; used ${fresh} (button "Search")\nClicked ${stale}\n`)
  expect(result.snapshot).toContain("Searched")
}, 30_000)

it("reads a replacement element and returns the fresh snapshot whose refs are now valid", async () => {
  const stale = refFor(snapshot, /heading "Fixture Home"/)
  await (await session.page()).evaluate(() => {
    const heading = document.querySelector("h1")!
    heading.replaceWith(heading.cloneNode(true))
  })
  const result = await call("browser_get_text", { ref: stale })
  const fresh = refFor(result.snapshot!, /heading "Fixture Home"/)
  expect(result.isError).toBeUndefined()
  expect(result.text).toBe(`ref ${stale} was stale; used ${fresh} (heading "Fixture Home")\nFixture Home`)
}, 30_000)

it("re-identifies an element whose snapshot line is YAML-quoted", async () => {
  const page = await session.page()
  await page.evaluate(() => document.body.insertAdjacentHTML("beforeend", `<button id="deal">Price: $42 "deal" it's #1</button>`))
  const stale = refFor((await call("browser_snapshot")).snapshot!, /^\s*- 'button "Price: \$42/)
  await page.evaluate(() => {
    const button = document.querySelector("#deal")!
    button.replaceWith(button.cloneNode(true))
  })
  const result = await call("browser_hover", { ref: stale })
  const fresh = refFor(result.snapshot!, /^\s*- 'button "Price: \$42/)
  expect(result.isError).toBeUndefined()
  expect(result.text).toStartWith(`ref ${stale} was stale; used ${fresh} (button "Price: $42 \\"deal\\" it's #1")\nHovered ${stale}\n`)
}, 30_000)

it.each([
  ["browser_click", {}, 'button "Search"', "#go"],
  ["browser_type", { text: "shoes" }, 'textbox "Search"', "#q"],
  ["browser_select_option", { values: ["pro"] }, 'combobox "Plan"', "select"],
  ["browser_hover", {}, 'link "Pricing"', "a"],
  ["browser_scroll", { direction: "down" }, 'heading "Fixture Home"', "h1"],
  ["browser_get_text", {}, 'heading "Fixture Home"', "h1"],
] as const)("fails %s at once with a fresh snapshot when its element is gone", async (name, args, identity, selector) => {
  const ref = refFor(snapshot, new RegExp(`${identity} \\[`))
  await (await session.page()).evaluate((selector) => document.querySelector(selector)!.remove(), selector)
  const started = performance.now()
  const result = await call(name, { ...args, ref })
  expect(performance.now() - started).toBeLessThan(1_000)
  expect(result.isError).toBe(true)
  expect(result.text).toStartWith(`ref ${ref} (${identity}) is no longer on the page, so nothing was done. Use a ref from this new snapshot.\n`)
  expect(result.snapshot).toContain("Page title: Fixture Home")
  expect(result.snapshot).not.toContain(`[ref=${ref}]`)
}, 30_000)

it.each([
  { when: "two identical elements replace it", after: () => {
    const button = document.querySelector("#go")!
    button.replaceWith(button.cloneNode(true), button.cloneNode(true))
  } },
  { when: "the only match was already a separate element", before: () => {
    document.body.append(document.querySelector("#go")!.cloneNode(true))
  }, after: () => document.querySelector("#go")!.remove() },
  { when: "the page URL changed", after: () => {
    history.pushState(null, "", "/moved")
    const button = document.querySelector("#go")!
    button.replaceWith(button.cloneNode(true))
  } },
])("does not substitute another element when $when", async ({ before, after }) => {
  const page = await session.page()
  if (before) {
    await page.evaluate(before)
    snapshot = (await call("browser_snapshot")).snapshot!
  }
  const ref = refFor(snapshot, /button "Search"/)
  await page.evaluate(after)
  const result = await call("browser_click", { ref })
  expect(result.isError).toBe(true)
  expect(result.text).toStartWith(`ref ${ref} (button "Search") is no longer on the page, so nothing was done.`)
  expect(result.snapshot).toContain('button "Search"')
  expect(await page.locator("#out").innerText()).toBe("Idle")
}, 30_000)

it("keeps refs that were never on the page as errors", async () => {
  // e999999 is the evaluation's stale ref; f99e1 names a frame that does not exist.
  for (const ref of ["e999999", "f99e1"]) {
    const started = performance.now()
    const result = await call("browser_click", { ref })
    expect(performance.now() - started).toBeLessThan(1_000)
    expect(result.isError).toBe(true)
    expect(result.text).toStartWith(`ref ${ref} is not on the page, so nothing was done.`)
    expect(result.snapshot).toContain("Page title: Fixture Home")
  }
}, 30_000)

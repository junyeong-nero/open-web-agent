import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { BrowserSession } from "./browser"
import { refFor, startFixtureServer } from "./testing/fixture"
import { callTool, selectTools, TOOLS, toolSpec } from "./tools"

const fixture = startFixtureServer()
const session = new BrowserSession({ headless: true })
const tools = selectTools()
const call = (name: string, args: unknown = {}) => callTool(tools, session, name, args)

beforeAll(async () => {
  await session.page()
})

afterAll(async () => {
  await session.close()
  fixture.stop()
})

describe("browser tools", () => {
  it("navigates and returns a snapshot with refs", async () => {
    const result = await call("browser_navigate", { url: `${fixture.url}/` })
    expect(result.isError).toBeUndefined()
    expect(result.snapshot).toContain("Page title: Fixture Home")
    expect(result.snapshot).toMatch(/button "Search" \[ref=e\d+\]/)
  })

  it("types, clicks, and selects by ref", async () => {
    const { snapshot = "" } = await call("browser_snapshot")
    await call("browser_type", { ref: refFor(snapshot, /textbox "Search"/), text: "shoes" })
    const clicked = await call("browser_click", { ref: refFor(snapshot, /button "Search"/), element: "Search button" })
    expect(clicked.text).toBe(`Clicked Search button\nLanding URL: ${fixture.url}/ | Title: Fixture Home`)
    expect(clicked.snapshot).toContain("Searched shoes")

    const selected = await call("browser_select_option", { ref: refFor(snapshot, /combobox "Plan"/), values: ["pro"] })
    expect(selected.isError).toBeUndefined()
    expect(await (await session.page()).locator("select").inputValue()).toBe("pro")
  })

  it("follows links, reads text, and goes back", async () => {
    const { snapshot = "" } = await call("browser_snapshot")
    const navigated = await call("browser_click", { ref: refFor(snapshot, /link "Pricing" \[/) })
    expect(navigated.snapshot).toContain("Page title: Pricing")
    expect((await call("browser_get_text")).text).toContain("The Pro plan costs $42 per month.")
    expect((await call("browser_go_back")).snapshot).toContain("Page title: Fixture Home")
  })

  it("switches to tabs opened by the page", async () => {
    const { snapshot = "" } = await call("browser_snapshot")
    const result = await call("browser_click", { ref: refFor(snapshot, /link "Pricing in new tab"/) })
    await (await session.page()).waitForLoadState("domcontentloaded")
    expect((await call("browser_snapshot")).snapshot).toContain("Page title: Pricing")
    expect(result.isError).toBeUndefined()
    await (await session.page()).close()
    expect((await call("browser_snapshot")).snapshot).toContain("Page title: Fixture Home")
  })

  it("returns screenshots as images", async () => {
    const result = await call("browser_screenshot")
    expect(result.image?.mimeType).toBe("image/png")
    expect(Buffer.from(result.image?.data ?? "", "base64").subarray(1, 4).toString()).toBe("PNG")
  })

  it("turns bad input into error results instead of throwing", async () => {
    expect((await call("browser_click", { ref: "#go" })).text).toContain("is not a snapshot ref")
    expect((await call("browser_click", {})).text).toContain("Invalid arguments for browser_click")
    expect((await call("browser_nope")).isError).toBe(true)
    expect((await call("browser_evaluate", { expression: "1" })).text).toContain("Unknown tool")
  })

  it("keeps unsafe tools opt-in and exports JSON schemas", () => {
    expect(tools.map((tool) => tool.name)).not.toContain("browser_evaluate")
    expect(selectTools(["core", "unsafe"]).map((tool) => tool.name)).toContain("browser_evaluate")
    for (const definition of TOOLS) {
      const spec = toolSpec(definition)
      expect(spec.inputSchema.type).toBe("object")
      expect(spec.inputSchema.$schema).toBeUndefined()
    }
  })
})

it("lists stable tab IDs and switches without losing the original form state", async () => {
  await call("browser_navigate", { url: fixture.url })
  const original = await session.page()
  await original.locator("#q").fill("preserve-me")
  const initial = JSON.parse((await call("browser_tabs")).text)
  const homeId = initial.find((tab: any) => tab.current).id
  const snapshot = (await call("browser_snapshot")).snapshot!
  await call("browser_click", { ref: refFor(snapshot, /link "Pricing in new tab"/) })
  const pricingPage = await session.page()
  await pricingPage.waitForLoadState("domcontentloaded")
  const tabs = JSON.parse((await call("browser_tabs")).text)
  const priceId = tabs.find((tab: any) => tab.current).id
  expect(tabs).toHaveLength(2)
  expect(priceId).not.toBe(homeId)
  expect(tabs.find((tab: any) => tab.id === homeId).url).toBe(fixture.url + "/")
  const returned = await call("browser_select_tab", { tabId: homeId })
  expect(returned.snapshot).toContain("Fixture Home")
  expect(returned.snapshot).toContain(`Page tab: ${homeId}`)
  expect(await original.locator("#q").inputValue()).toBe("preserve-me")
  expect(await session.page()).toBe(original)
  await call("browser_type", { ref: refFor(returned.snapshot!, /textbox "Search"/), text: "selected-tab" })
  expect(await original.locator("#q").inputValue()).toBe("selected-tab")
  await pricingPage.close()
  expect((await call("browser_select_tab", { tabId: priceId })).text).toContain("Unknown or closed tab")
  expect((await call("browser_select_tab", { tabId: "t999999" })).isError).toBe(true)
  expect((await call("browser_select_tab", { tabId: "e1" })).isError).toBe(true)
  expect(await session.page()).toBe(original)
  expect(JSON.parse((await call("browser_tabs")).text)).toHaveLength(1)
})

it("does not reuse closed tab IDs after a browser session restarts", async () => {
  const browser = new BrowserSession({ headless: true })
  try {
    const oldId = (await browser.tabs())[0].id
    await browser.close()
    const newId = (await browser.tabs())[0].id
    expect(newId).not.toBe(oldId)
    await expect(browser.selectTab(oldId)).rejects.toThrow("Unknown or closed tab")
  } finally { await browser.close() }
}, 10_000)

it("bounds landing metadata to one line without changing the snapshot", async () => {
  const observed = new BrowserSession()
  const snapshot = `Page URL: https://example.test/sorry?${"x".repeat(400)}\nPage title: Just a moment...\n${"y".repeat(200)}\nPage tab: t1\nSnapshot:\n- heading "Check"`
  observed.snapshot = async () => snapshot
  const result = await callTool(tools, observed, "browser_snapshot", {})
  expect(result.snapshot).toBe(snapshot)
  const lines = result.text.split("\n")
  expect(lines).toHaveLength(2)
  expect(lines[1]).toBe(`Landing URL: ${("https://example.test/sorry?" + "x".repeat(400)).slice(0, 159)}… | Title: ${("Just a moment... " + "y".repeat(200)).slice(0, 119)}…`)

  observed.snapshot = async () => "Page URL: about:blank\nPage title: \nPage tab: t1\nSnapshot:\n"
  expect((await callTool(tools, observed, "browser_snapshot", {})).text).toBe("Captured page snapshot\nLanding URL: about:blank | Title: ")

  observed.selectTab = async () => {}
  observed.snapshot = async () => { throw new Error("Observation failed") }
  const failed = await callTool(tools, observed, "browser_select_tab", { tabId: "t1" })
  expect(failed.isError).toBeUndefined()
  expect(failed.text).toContain("follow-up snapshot failed")
  expect(failed.text).not.toContain("Landing URL:")
})

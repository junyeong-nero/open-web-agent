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
    expect(clicked.text).toBe("Clicked Search button")
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

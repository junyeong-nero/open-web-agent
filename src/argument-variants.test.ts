import { afterAll, expect, it } from "bun:test"
import type { Page } from "playwright"
import { BrowserSession } from "./browser"
import { refFor, startFixtureServer } from "./testing/fixture"
import { callTool, selectTools } from "./tools"

const tools = selectTools()
const fixture = startFixtureServer()
const session = new BrowserSession({ headless: true })
const call = (name: string, args: unknown) => callTool(tools, session, name, args)

afterAll(async () => {
  await session.close()
  fixture.stop()
})

it("treats null optional arguments as omitted and keeps a null required argument invalid", async () => {
  await call("browser_navigate", { url: `${fixture.url}/pricing` })
  const args = { ref: null }
  const read = await call("browser_get_text", args)
  expect(read.isError).toBeUndefined()
  expect(read.text).toContain("The Pro plan costs $42 per month.")
  expect(args).toEqual({ ref: null })
  expect((await call("browser_scroll", { direction: "down", pixels: null, ref: null })).text).toStartWith("Scrolled down 800px")
  expect(await call("browser_click", { ref: null, element: null })).toEqual({
    text: "Invalid arguments for browser_click: ✖ Invalid input: expected string, received null\n  → at ref",
    isError: true,
  })
})

it("spells named keys the way Playwright does in any case and keeps single characters as given", async () => {
  const pressed: string[] = []
  const keyboard = new BrowserSession()
  keyboard.page = async () => ({
    waitForEvent: async () => { throw new Error("No navigation") },
    keyboard: { press: async (key: string) => { pressed.push(key) } },
  }) as unknown as Page
  keyboard.snapshot = async () => "Snapshot:\n"
  const keys: Record<string, string> = {
    END: "End", ARROWDOWN: "ArrowDown", pagedown: "PageDown", numpadenter: "NumpadEnter", f5: "F5",
    ESC: "Escape", Ctrl: "Control", CONTROL: "Control", CMD: "Meta", command: "Meta", DEL: "Delete",
    "CTRL+A": "Control+A", "ctrl+SHIFT+tab": "Control+Shift+Tab", "CMD++": "Meta++",
    a: "a", A: "A", "Shift+A": "Shift+A", Enter: "Enter", NOPE: "NOPE",
  }
  for (const [key, expected] of Object.entries(keys)) {
    expect((await callTool(tools, keyboard, "browser_press_key", { key })).text).toBe(`Pressed ${expected}`)
  }
  expect(pressed).toEqual(Object.values(keys))
})

it("presses key variants in the page and releases a chord's keys when one is unknown", async () => {
  const { snapshot = "" } = await call("browser_navigate", { url: `${fixture.url}/` })
  await call("browser_type", { ref: refFor(snapshot, /textbox "Search"/), text: "shoes" })
  const input = (await session.page()).locator("#q")
  for (const key of ["CTRL+A", "A", "a"]) expect((await call("browser_press_key", { key })).isError).toBeUndefined()
  expect(await input.inputValue()).toBe("Aa")

  const unknown = await call("browser_press_key", { key: "CTRL+NOPE" })
  expect(unknown.isError).toBe(true)
  expect(unknown.text).toContain('Unknown key: "NOPE"')
  // A held Control would turn this into Control+x.
  await call("browser_press_key", { key: "x" })
  expect(await input.inputValue()).toBe("Aax")
})

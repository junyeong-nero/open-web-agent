import { afterAll, expect, it } from "bun:test"
import { BrowserSession } from "./browser"
import { refFor, startFixtureServer } from "./testing/fixture"
import { callTool, selectTools } from "./tools"

const fixture = startFixtureServer()
const session = new BrowserSession({ headless: true })
const call = (name: string, args: Record<string, unknown> = {}) => callTool(selectTools(), session, name, args)
const notice = (max: number) => `\n… [snapshot truncated at ${max} chars]`

afterAll(async () => {
  await session.close()
  fixture.stop()
})

it("drops the links' /url: lines and keeps every other line byte-identical", () => {
  const tree = [
    "- generic [ref=e1]:",
    '  - link "Pricing" [ref=e2] [cursor=pointer]:',
    "    - /url: https://shop.example/pricing?plan=pro",
    '    - img "Pro plan" [ref=e3]',
    '  - link "Top" [ref=e4]:',
    '    - /url: "#top"',
    "  - text: Read the guide at https://shop.example/url/guide",
    '  - textbox "Search" [ref=e5]:',
    "    - /placeholder: https://shop.example/search",
  ].join("\n")
  expect(new BrowserSession().shown(tree)).toBe([
    "- generic [ref=e1]:",
    '  - link "Pricing" [ref=e2] [cursor=pointer]:',
    '    - img "Pro plan" [ref=e3]',
    '  - link "Top" [ref=e4]:',
    "  - text: Read the guide at https://shop.example/url/guide",
    '  - textbox "Search" [ref=e5]:',
    "    - /placeholder: https://shop.example/search",
  ].join("\n"))
})

it("drops link URLs before the cut, so the budget holds more of the page", () => {
  const tree = Array.from({ length: 3 }, (_, index) => `- link "Item ${index}" [ref=e${index + 1}]:\n  - /url: https://shop.example/items/${index}`).join("\n")
  const kept = Array.from({ length: 3 }, (_, index) => `- link "Item ${index}" [ref=e${index + 1}]:`).join("\n")
  expect(new BrowserSession({ maxSnapshotChars: kept.length }).shown(tree)).toBe(kept)
  expect(new BrowserSession({ maxSnapshotChars: kept.length - 1 }).shown(tree)).toBe(kept.slice(0, -1) + notice(kept.length - 1))
})

it("shows links without URLs, and clicking a link's ref still opens its page", async () => {
  const home = (await call("browser_navigate", { url: `${fixture.url}/` })).snapshot!
  expect(home).toContain('- link "Pricing" [ref=')
  expect(home).not.toContain("/url:")
  // The captured tree keeps them, as the page wrote them.
  expect(session.lastSnapshot!.tree).toContain("- /url: /pricing")
  const clicked = await call("browser_click", { ref: refFor(home, /link "Pricing" \[/) })
  expect(clicked.isError).toBeUndefined()
  expect(clicked.snapshot).toStartWith(`Page URL: ${fixture.url}/pricing\nPage title: Pricing\n`)
}, 30_000)

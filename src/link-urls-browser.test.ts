import { afterAll, expect, it } from "bun:test"
import { BrowserSession } from "./browser"
import { refFor, startFixtureServer } from "./testing/fixture"
import { callTool, selectTools } from "./tools"

const fixture = startFixtureServer()
const session = new BrowserSession({ headless: true })
const call = (name: string, args: Record<string, unknown> = {}) => callTool(selectTools(), session, name, args)
/** The tree part of a snapshot, after its page header. */
const bodyOf = (snapshot: string) => snapshot.slice(snapshot.indexOf("\nSnapshot:\n") + "\nSnapshot:\n".length)

afterAll(async () => {
  await session.close()
  fixture.stop()
})

it("opens the same page through a link's ref and through its compacted URL", async () => {
  // Bing's click-tracking page forwards the browser to the target in its u parameter; here it stays on this machine.
  await (await session.page()).context().route(/^https:\/\/www\.bing\.com\/ck\/a\?/, (route) => route.fulfill({
    status: 302,
    headers: { location: Buffer.from(new URL(route.request().url()).searchParams.get("u")!.slice(2), "base64url").toString() },
  }))
  const links = `${fixture.url}/links`
  const opened = (await call("browser_navigate", { url: links })).snapshot!
  const tree = session.lastSnapshot!.tree
  // The snapshot shows short URLs, while the captured tree keeps the hrefs as the page wrote them.
  expect(opened).toContain("\n    - /url: /pricing?plan=pro\n")
  expect(opened).toContain("\n    - /url: /pricing?plan=team")
  expect(tree).toContain(`- /url: ${fixture.url}/pricing?plan=pro&utm_source=newsletter&gclid=abc123\n`)
  expect(tree).toContain("- /url: https://www.bing.com/ck/a?")
  // Every other line, ref lines included, is the same.
  const others = (text: string) => text.split("\n").filter((line) => !line.includes("- /url: "))
  expect(others(bodyOf(opened))).toEqual(others(tree))

  for (const [name, path, href] of [
    ["Pro plan", "/pricing?plan=pro", "/pricing?plan=pro&utm_source=newsletter&gclid=abc123"],
    ["Team plan search result", "/pricing?plan=team", "/pricing?plan=team"],
  ] as const) {
    const before = (await call("browser_navigate", { url: links })).snapshot!
    const clicked = await call("browser_click", { ref: refFor(before, new RegExp(`link "${name}"`)) })
    expect(clicked.isError).toBeUndefined()
    expect(clicked.snapshot).toStartWith(`Page URL: ${fixture.url}${href}\nPage title: Pricing\n`)
    // A model resolves the path against the Page URL of the snapshot that showed it.
    const navigated = await call("browser_navigate", { url: new URL(path, links).href })
    expect(navigated.isError).toBeUndefined()
    expect(navigated.snapshot).toStartWith(`Page URL: ${fixture.url}${path}\nPage title: Pricing\n`)
    expect(bodyOf(navigated.snapshot!)).toBe(bodyOf(clicked.snapshot!))
  }
}, 30_000)

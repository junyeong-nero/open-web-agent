import { afterAll, expect, it } from "bun:test"
import type { Page } from "playwright"
import { BrowserSession } from "./browser"
import { refFor, startFixtureServer } from "./testing/fixture"
import { callTool, selectTools } from "./tools"

const fixture = startFixtureServer()
const session = new BrowserSession({ headless: true })
const call = (name: string, args: Record<string, unknown> = {}) => callTool(selectTools(), session, name, args)
const shownFirst = "Open dialog (shown first; the page behind it may not accept clicks):"
const notice = (max: number) => `\n… [snapshot truncated at ${max} chars]`
/** The tree part of a snapshot, after its page header. */
const bodyOf = (snapshot: string) => snapshot.slice(snapshot.indexOf("\nSnapshot:\n") + "\nSnapshot:\n".length)

/** The tree part of the snapshot of a page whose aria snapshot is `tree`, without launching a browser. */
async function shown(tree: string, maxSnapshotChars: number): Promise<string> {
  const stub = new BrowserSession({ maxSnapshotChars })
  stub.page = async () => ({
    ariaSnapshot: async () => tree,
    url: () => "https://example.test/",
    title: async () => "Stub",
    setDefaultTimeout: () => {},
    on: () => {},
  }) as unknown as Page
  return bodyOf(await stub.snapshot())
}

afterAll(async () => {
  await session.close()
  fixture.stop()
})

it("shows a modal from past the cut first, and its refs act on the page", async () => {
  const navigated = (await call("browser_navigate", { url: `${fixture.url}/trade-in` })).snapshot!
  const opened = await call("browser_click", { ref: refFor(navigated, /button "See all values"/) })
  const tree = session.lastSnapshot!.tree
  // As on apple.com, the modal starts past the 40,000-character cut.
  expect(tree.indexOf('dialog "Trade-in values"')).toBeGreaterThan(40_000)
  const body = bodyOf(opened.snapshot!)
  expect(body).toStartWith(`${shownFirst}\n- dialog "Trade-in values" [active] [ref=`)
  expect(body).toContain('- row "Phone 11 Pro Max Up to $140" [ref=')
  expect(body).toContain('\n  - button "Close" [ref=')
  expect(body).toContain('\nRest of the page:\n- generic [ref=e1]:\n  - heading "Trade in your device" [level=1] [ref=e2]\n')
  // The dialog and the rest of the page share the budget; only the labels and the notice come on top.
  expect(body).toEndWith(notice(40_000))
  expect(body.length).toBe(40_000 + `${shownFirst}\n\nRest of the page:\n${notice(40_000)}`.length)
  // Moved or not, every ref shown comes from the one snapshot and resolves to one element.
  const refs = [...body.matchAll(/\[ref=(\w+)\]/g)].map(([, ref]) => ref)
  expect(await Promise.all(refs.map(async (ref) => (await session.locator(ref)).count()))).toEqual(refs.map(() => 1))
  // Stale refs are re-identified (#146) in the whole tree as captured, not in the text shown.
  expect(tree).toBe(await (await session.page()).ariaSnapshot({ mode: "ai" }))

  const closed = await call("browser_click", { ref: refFor(body, /button "Close"/) })
  expect(closed.isError).toBeUndefined()
  expect(await (await session.page()).locator("#portal").innerHTML()).toBe("")
  // Without a dialog, a long page is cut as before.
  expect(bodyOf(closed.snapshot!)).toBe(session.lastSnapshot!.tree.slice(0, 40_000) + notice(40_000))
}, 30_000)

const dialog = [
  '- dialog "Filter & Sort" [ref=e4]:',
  '  - checkbox "Credit Eligible" [ref=e5]',
  '  - button "Show results" [ref=e6]',
].join("\n")
const rest = [
  "- generic [ref=e1]:",
  '  - heading "Results" [level=1] [ref=e2]',
  '  - button "Filter & Sort" [ref=e3]',
  "  - list [ref=e7]:",
  "    - listitem [ref=e8]: Machine Learning",
  "    - listitem [ref=e9]: Deep Learning",
].join("\n")
// The page as captured, with the dialog inside it before the list.
const results = rest.replace("\n  - list", `\n${dialog.replace(/^/gm, "  ")}\n  - list`)

it("leaves snapshots within the limit and long pages without a dialog as they were", async () => {
  expect(await shown(results, results.length)).toBe(results)
  expect(await shown(rest, 50)).toBe(rest.slice(0, 50) + notice(50))
})

it("fills what the dialog leaves of the limit with the rest of the page, and keeps the front of a longer dialog", async () => {
  expect(await shown(results, 150)).toBe(`${shownFirst}\n${dialog}\nRest of the page:\n${rest.slice(0, 150 - dialog.length)}${notice(150)}`)
  expect(await shown(results, 40)).toBe(`${shownFirst}\n${dialog.slice(0, 40)}${notice(40)}`)
})

it("moves every dialog and alertdialog subtree, the one holding the focus first", async () => {
  const tree = [
    "- generic [ref=e1]:",
    "  - main [ref=e2]: Page content",
    "  - 'dialog \"Cookies: your choice\" [ref=e3]':",
    '    - button "Accept" [ref=e4]',
    "  - generic [ref=e5]:",
    '    - alertdialog "Sign in" [ref=e6]:',
    '      - textbox "Email" [active] [ref=e7]',
    '      - dialog "Help" [ref=e8]: Nested help',
    "  - contentinfo [ref=e9]: Footer",
  ].join("\n")
  // Moved to the top level, everything fits again, so nothing is cut.
  expect(await shown(tree, tree.length - 1)).toBe([
    shownFirst,
    '- alertdialog "Sign in" [ref=e6]:',
    '  - textbox "Email" [active] [ref=e7]',
    '  - dialog "Help" [ref=e8]: Nested help',
    "- 'dialog \"Cookies: your choice\" [ref=e3]':",
    '  - button "Accept" [ref=e4]',
    "Rest of the page:",
    "- generic [ref=e1]:",
    "  - main [ref=e2]: Page content",
    "  - generic [ref=e5]:",
    "  - contentinfo [ref=e9]: Footer",
  ].join("\n"))
})

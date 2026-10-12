import { afterAll, afterEach, beforeEach, expect, it } from "bun:test"
import { type AgentEvent, render, runAgent } from "./agent"
import { BrowserSession } from "./browser"
import type { Message, ModelRequest } from "./model/types"
import { refFor, startFixtureServer } from "./testing/fixture"
import { currentPage, scriptedModel } from "./testing/scripted-model"
import type { ToolResult } from "./tools"

type Entry = Parameters<typeof render>[0][number]

const fixture = startFixtureServer()
let session: BrowserSession
beforeEach(() => { session = new BrowserSession({ headless: true }) })
afterEach(async () => { await session.close() })
afterAll(() => fixture.stop())

const CHANGES = "[Changes since the last full snapshot of this page: that snapshot plus these changes is the current page, and refs on its unchanged lines still work."
const tool = (id: string, name: string, args: Record<string, unknown> = {}) => ({ toolCalls: [{ id, name, arguments: args }] })
/** The page state in a rendered message: a tool result's snapshot part. */
const pageState = (message: Message | undefined) => message?.role === "tool" && message.content[1]?.type === "text" ? message.content[1].text : ""
/** The page state that a request ends with. */
const newest = (request: ModelRequest) => pageState(request.messages.at(-1))
/** The tool results the agent took, in order. */
const results = (events: AgentEvent[]) => events.flatMap((event) => event.type === "tool" ? [event.result] : [])

it("shows a panel opened on the same page as changes, whose refs and the unchanged refs of the full snapshot both work", async () => {
  const events: AgentEvent[] = []
  const model = scriptedModel([
    () => tool("1", "browser_navigate", { url: `${fixture.url}/catalog` }),
    (request) => tool("2", "browser_click", { ref: refFor(newest(request), /button "Filters"/) }),
    // A ref that only the changes show.
    (request) => tool("3", "browser_click", { ref: refFor(newest(request), /^\+ *- button "In stock"/) }),
    // A ref from the full snapshot two messages back, on a line that has not changed since.
    (request) => tool("4", "browser_click", { ref: refFor(pageState(request.messages[2]), /button "Next page"/) }),
    () => ({ text: "done", toolCalls: [] }),
  ])
  const result = await runAgent({ task: "Browse the catalog", model, browser: session, onEvent: (event) => events.push(event) })
  expect(result).toMatchObject({ status: "completed", stopReason: "final_answer" })
  const taken = results(events)
  expect(taken.map((result) => result.isError ?? false)).toEqual([false, false, false, false])
  const [opened, filtered, stocked, paged] = model.requests.slice(1)

  // Only the panel and the moved focus are new; the 30 items stay in the full snapshot.
  const changes = newest(filtered!)
  expect(changes).toStartWith(CHANGES)
  expect(changes).toContain(`Page URL: ${fixture.url}/catalog\nPage title: Catalog\nPage tab: t1\nSnapshot changes:\n`)
  expect(changes).toMatch(/^\+ {2}- dialog "Filters" \[ref=e\d+\]:\n\+ {4}- button "In stock" \[ref=e\d+\]\n\+ {4}- button "Close" \[ref=e\d+\]$/m)
  expect(changes).not.toContain("Item 5")
  expect(changes.split("\n").length).toBeLessThan(newest(opened!).split("\n").length / 2)
  // The full snapshot plus the changes is exactly the snapshot the click took.
  expect(currentPage(filtered!.messages)).toBe(taken[1]!.snapshot!)
  expect(pageState(filtered!.messages[2])).toBe(taken[0]!.snapshot!)

  // The renamed button got a new ref; the newest changes still count from the same full snapshot.
  expect(newest(stocked!)).toStartWith(CHANGES)
  expect(newest(stocked!)).toMatch(/^\+ {4}- button "In stock only" \[active\] \[ref=e\d+\]$/m)
  expect(pageState(stocked!.messages[4])).toBe("[older snapshot omitted: superseded by a newer one]")
  expect(currentPage(stocked!.messages)).toBe(taken[2]!.snapshot!)

  // The request prefix through the full snapshot stays byte-identical while changes follow it.
  for (const request of [filtered!, stocked!]) expect(request.messages.slice(0, 3)).toEqual(opened!.messages)
  expect(stocked!.messages.slice(0, 4)).toEqual(filtered!.messages.slice(0, 4))

  // Next page replaced every item: far more than 30% of the lines changed, so the page comes whole.
  expect(newest(paged!)).toBe(taken[3]!.snapshot!)
  expect(newest(paged!)).toContain("listitem [ref=e")
  expect(newest(paged!)).toContain("Item 31")
}, 30_000)

it("shows the page whole after browser_snapshot, browser_navigate and browser_go_back", async () => {
  const events: AgentEvent[] = []
  const model = scriptedModel([
    () => tool("1", "browser_navigate", { url: `${fixture.url}/catalog` }),
    (request) => tool("2", "browser_click", { ref: refFor(newest(request), /button "Filters"/) }),
    () => tool("3", "browser_snapshot"),
    () => tool("4", "browser_navigate", { url: `${fixture.url}/catalog` }),
    (request) => tool("5", "browser_click", { ref: refFor(newest(request), /link "Pricing"/) }),
    () => tool("6", "browser_go_back"),
    () => ({ text: "done", toolCalls: [] }),
  ])
  await runAgent({ task: "Browse the catalog", model, browser: session, onEvent: (event) => events.push(event) })
  const taken = results(events)
  const shown = model.requests.slice(1).map(newest)
  expect(shown[1]).toStartWith(CHANGES)
  // An explicit snapshot is whole even though the page has not changed since the click.
  expect(taken[2]!.snapshot).toBe(taken[1]!.snapshot!)
  for (const index of [2, 3, 4, 5]) expect(shown[index]).toBe(taken[index]!.snapshot!)
  // The click on Pricing opened another document.
  expect(taken[4]).toMatchObject({ navigated: true })
}, 30_000)

/** A page in the format of `BrowserSession.snapshot`. */
const snapshot = (lines: string[], url = "https://shop.example/list", tab = "t1") => `Page URL: ${url}\nPage title: List\nPage tab: ${tab}\nSnapshot:\n${lines.join("\n")}`
const items = Array.from({ length: 20 }, (_, index) => `  - listitem [ref=e${index + 2}]: Item ${index + 1}`)
const list = (...extra: string[]) => ["- list [ref=e1]:", ...items.slice(0, 10), ...extra, ...items.slice(10)]
const more = '  - button "More" [ref=e30]'
/** A model's call and its tool's result. */
const call = (id: string, name: string, result: ToolResult): Entry[] => [
  { role: "assistant", toolCalls: [{ id, name, arguments: {} }] },
  { role: "tool", toolCallId: id, name, result },
]
const opened = call("1", "browser_navigate", { text: "Navigated", snapshot: snapshot(list()) })

it.each([
  ["browser_snapshot", call("2", "browser_snapshot", { text: "Captured page snapshot", snapshot: snapshot(list(more)) })],
  ["browser_navigate", call("2", "browser_navigate", { text: "Navigated", snapshot: snapshot(list(more)) })],
  ["browser_go_back", call("2", "browser_go_back", { text: "Went back", snapshot: snapshot(list(more)) })],
  ["an action whose main frame navigated", call("2", "browser_click", { text: "Clicked", snapshot: snapshot(list(more)), navigated: true })],
  ["an action on another tab", call("2", "browser_click", { text: "Clicked", snapshot: snapshot(list(more), undefined, "t2") })],
  ["an action on another URL", call("2", "browser_click", { text: "Clicked", snapshot: snapshot(list(more), "https://shop.example/list?page=2") })],
  ["an action that changed over 30% of the lines", call("2", "browser_click", {
    text: "Clicked", snapshot: snapshot(list(...Array.from({ length: 10 }, (_, index) => `  - listitem [ref=e${index + 40}]: New ${index}`))),
  })],
  ["an action after unavailable page state", [
    ...call("2", "browser_click", { text: "Clicked", snapshot: "[Current page state unavailable. Previous snapshot refs may be stale.]" }),
    ...call("3", "browser_click", { text: "Clicked", snapshot: snapshot(list(more)) }),
  ]],
] as Array<[string, Entry[]]>)("shows the page whole after %s", (_, next) => {
  const last = next.at(-1)!
  expect(pageState(render([...opened, ...next], "t").at(-1))).toBe("result" in last ? last.result.snapshot! : "")
})

it.each([
  ["a click", call("2", "browser_click", { text: "Clicked", snapshot: snapshot(list(more)) })],
  ["a scroll that moved to a fragment", call("2", "browser_scroll", { text: "Scrolled", snapshot: snapshot(list(more), "https://shop.example/list#more") })],
  ["a failed action that returned the page", call("2", "browser_click", { text: "ref e99 is not on the page", snapshot: snapshot(list(more)), isError: true })],
] as Array<[string, Entry[]]>)("shows the page as changes after %s on it", (_, next) => {
  const messages = render([...opened, ...next], "t")
  expect(pageState(messages.at(-1))).toStartWith(CHANGES)
  // The new line follows the line before it and its parent, with "…" for the unchanged lines between and after.
  expect(pageState(messages.at(-1))).toEndWith(`Snapshot changes:\n - list [ref=e1]:\n…\n   - listitem [ref=e11]: Item 10\n+${more}\n…`)
  expect(currentPage(messages)).toBe("result" in next[1]! ? next[1].result.snapshot! : "")
})

it("says when nothing changed since the full snapshot", () => {
  const messages = render([...opened, ...call("2", "browser_hover", { text: "Hovered", snapshot: snapshot(list()) })], "t")
  expect(pageState(messages.at(-1))).toEndWith("Page tab: t1\nSnapshot changes:\n(none)")
  expect(currentPage(messages)).toBe(snapshot(list()))
})

it("gives exactly the snapshot taken when its changes are applied to the full snapshot, even among repeated lines", () => {
  // Lines without a ref repeat, as text and list lines do on real pages, so a change must say which of them it follows.
  let seed = 7
  const random = (below: number) => {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648
    return Math.floor((seed / 2_147_483_648) * below)
  }
  let ref = 0
  const node = (depth: number) => `${"  ".repeat(depth)}- ${["text: Notes", "list", "img", `generic [ref=e${++ref}]:`, `link "Item ${ref}" [ref=e${++ref}]`][random(5)]}`
  let shownAsChanges = 0
  for (let round = 0; round < 300; round++) {
    const tree: string[] = []
    for (let depth = 0; tree.length < 60; depth = Math.max(0, Math.min(depth + random(3) - 1, 6))) tree.push(node(depth))
    const changed = [...tree]
    for (let edit = random(6); edit >= 0; edit--) {
      const at = random(changed.length)
      const kind = random(3)
      if (kind === 0) changed.splice(at, 1)
      else if (kind === 1) changed.splice(at, 0, ...Array.from({ length: 1 + random(3) }, () => node(random(5))))
      else changed[at] = node(random(5))
    }
    const messages = render([
      ...call("1", "browser_navigate", { text: "Navigated", snapshot: snapshot(tree) }),
      ...call("2", "browser_click", { text: "Clicked", snapshot: snapshot(changed) }),
    ], "t")
    if (pageState(messages.at(-1)).startsWith(CHANGES)) shownAsChanges++
    expect(currentPage(messages)).toBe(snapshot(changed))
  }
  expect(shownAsChanges).toBeGreaterThan(200)
})

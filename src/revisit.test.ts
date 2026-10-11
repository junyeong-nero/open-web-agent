import { expect, it } from "bun:test"
import { z } from "zod"
import { runAgent } from "./agent"
import { BrowserSession } from "./browser"
import type { ModelRequest, ToolCall } from "./model/types"
import { refFor, startFixtureServer } from "./testing/fixture"
import { lastToolText, scriptedModel } from "./testing/scripted-model"
import type { BrowserTool } from "./tools"

const SITE = "https://site.test"
/** A page at `url` on its `load`th load, after a click on `control` when one was clicked since it opened. */
type Page = (url: string, load: number, control?: string) => { title: string; body: string }
/** A tool and the URL it moves to, or the control it clicks or the element whose text it reads. */
type Call = [tool: string, target?: string]

/** Like real pages, refs shift and a clock line changes on every load. */
const site: Page = (url, load) => {
  const path = new URL(url).pathname
  return {
    title: path,
    body: [
      `- banner [ref=e${load}]:`,
      `  - link "Home" [ref=e${load + 1}]`,
      `- heading "${path}" [level=1] [ref=e${load + 2}]`,
      `- paragraph: Content of ${path}`,
      `- paragraph: Details of ${path}`,
      `- text: Updated ${load} minutes ago`,
    ].join("\n"),
  }
}

/** Unknown paths show the same not-found page, which names the path; other paths are `site` pages. */
const notFound: Page = (url, load) => {
  const path = new URL(url).pathname
  if (!path.startsWith("/missing")) return site(url, load)
  return {
    title: "Page not found",
    body: [
      `- banner [ref=e${load}]:`,
      `  - link "Home" [ref=e${load + 1}]`,
      `- heading "Page not found" [level=1] [ref=e${load + 2}]`,
      `- paragraph: Nothing is at ${path}.`,
      "- paragraph: Check the address or search the site.",
      `- searchbox "Search" [ref=e${load + 3}]`,
      `- text: Updated ${load} minutes ago`,
    ].join("\n"),
  }
}

/** A navigation of 40 links, like the shared menus that are most of many real pages. */
const navigation = (load: number) => [
  `- navigation [ref=e${load}]:`,
  ...Array.from({ length: 40 }, (_, index) => `  - link "Category ${index + 1}" [ref=e${load + 1 + index}]`),
]

/** A store whose pages share the navigation; a product adds a dozen lines of its own. */
const store: Page = (url, load) => {
  const path = new URL(url).pathname
  const own = path === "/list"
    ? Array.from({ length: 6 }, (_, index) => `- link "Item ${index + 1}" [ref=e${load + 41 + index}]`)
    : Array.from({ length: 12 }, (_, index) => `- listitem: ${path} fact ${index + 1}`)
  return { title: path, body: [...navigation(load), `- heading "${path}" [level=1]`, ...own, `- text: Updated ${load} minutes ago`].join("\n") }
}

const TABS = ["Overview", "Specs", "Reviews", "Questions", "Shipping", "Returns", "Warranty"]

/** A product page whose tabs each show a dozen lines below the navigation. */
const product: Page = (_url, load, tab = "Overview") => ({
  title: "Product",
  body: [
    ...navigation(load),
    ...TABS.map((name, index) => `- tab "${name}"${name === tab ? " [selected]" : ""} [ref=e${load + 41 + index}]`),
    ...Array.from({ length: 12 }, (_, index) => `- listitem: ${tab} fact ${index + 1}`),
  ].join("\n"),
})

/**
 * Tools that move to `url`, or click `ref` on the current page, and return the page in BrowserSession.snapshot() format;
 * browser_get_text returns the same text for the same `ref`.
 */
function fakeTools(page: Page): BrowserTool[] {
  let current = ""
  let control: string | undefined
  let load = 0
  const read: BrowserTool = {
    name: "browser_get_text", description: "read", schema: z.object({ ref: z.string() }), readOnly: true, capability: "core",
    async run(_session, { ref }) { return { pageText: true, text: `Text of ${ref}` } },
  }
  return [read, ...["browser_navigate", "browser_click", "browser_go_back", "browser_scroll", "browser_wait_for"].map((name): BrowserTool => ({
    name, description: name, schema: z.object({ url: z.string().optional(), ref: z.string().optional() }), readOnly: false, capability: "core",
    async run(_session, { url, ref }) {
      if (url) [current, control] = [url, undefined]
      control = ref ?? control
      const { title, body } = page(current.replace(/#.*/, ""), ++load, control)
      return { text: `${name} ${current}`, snapshot: `Page URL: ${current}\nPage title: ${title}\nPage tab: t1\nSnapshot:\n${body}` }
    },
  }))]
}

/** One tool call per step, then a final answer the run reaches unless it is stopped. */
function script(calls: Call[]) {
  return scriptedModel([
    ...calls.map(([name, target], index) => () => ({
      toolCalls: [{ id: `${index + 1}`, name, arguments: target === undefined ? {} : target.startsWith("http") ? { url: target } : { ref: target } }],
    })),
    () => ({ text: "done", toolCalls: [] }),
  ])
}

async function browse(calls: Call[], page = site, browser = new BrowserSession({ headless: true })) {
  return { result: await runAgent({ task: "t", browser, model: script(calls), tools: fakeTools(page) }) }
}

/** In a real browser, open `path` on the fixture site, then make one tool call per reply, built from the last tool result. */
async function browseFixture(path: string, replies: Array<(last: string) => Omit<ToolCall, "id">>) {
  const fixture = startFixtureServer()
  const browser = new BrowserSession({ headless: true })
  try {
    const model = scriptedModel([
      () => ({ toolCalls: [{ id: "0", name: "browser_navigate", arguments: { url: fixture.url + path } }] }),
      ...replies.map((reply, index) => (request: ModelRequest) => ({ toolCalls: [{ id: `${index + 1}`, ...reply(lastToolText(request.messages)) }] })),
      () => ({ text: "done", toolCalls: [] }),
    ])
    return { url: fixture.url + path, result: await runAgent({ task: "t", browser, model }) }
  } finally {
    await browser.close()
    fixture.stop()
  }
}

it("stops a cycle on a page's fourth non-consecutive repeat", async () => {
  const { result } = await browse([
    ["browser_navigate", `${SITE}/a`],
    ["browser_click", `${SITE}/b`],
    ["browser_go_back", `${SITE}/a`],
    ["browser_navigate", `${SITE}/b`],
    ["browser_navigate", `${SITE}/a#details`],
    ["browser_click", `${SITE}/b`],
    ["browser_navigate", `${SITE}/a`],
    ["browser_navigate", `${SITE}/b`],
    ["browser_navigate", `${SITE}/a#top`],
  ])
  expect(result).toMatchObject({ status: "failed", stopReason: "no_progress", steps: 9, error: `Stopped after opening ${SITE}/a 5 times without finding anything new` })
})

it("does not count a list revisited between new detail pages", async () => {
  const calls: Call[] = [["browser_navigate", `${SITE}/list`]]
  for (let item = 1; item <= 6; item++) calls.push(["browser_click", `${SITE}/item/${item}`], ["browser_navigate", `${SITE}/list`])
  const { result } = await browse(calls)
  expect(result).toMatchObject({ status: "completed", stopReason: "final_answer", steps: 14 })
})

it("does not count scrolls and waits between page visits", async () => {
  const calls: Call[] = []
  for (const path of ["/a", "/b", "/a", "/b", "/a"]) calls.push(["browser_navigate", `${SITE}${path}`], ["browser_scroll"], ["browser_wait_for"], ["browser_scroll"])
  const { result } = await browse(calls)
  expect(result).toMatchObject({ status: "completed", stopReason: "final_answer", steps: 21 })
})

it("does not count a re-opened page whose content changed", async () => {
  const live: Page = (url, load) => url.endsWith("/status") ? { title: "Status", body: `- paragraph: Step ${load}\n- paragraph: Log ${load}` } : site(url, load)
  const calls: Call[] = []
  for (let round = 0; round < 6; round++) calls.push(["browser_navigate", `${SITE}/status`], ["browser_navigate", `${SITE}/a`])
  const { result } = await browse(calls, live)
  expect(result).toMatchObject({ status: "completed", stopReason: "final_answer" })
})

it("counts the page already open when the task starts as its first visit", async () => {
  class OpenSession extends BrowserSession {
    override get started() { return true }
    override async snapshot() { return `Page URL: ${SITE}/a\nPage title: /a\nPage tab: t1\nSnapshot:\n${site(`${SITE}/a`, 0).body}` }
  }
  const calls: Call[] = []
  for (let round = 0; round < 4; round++) calls.push(["browser_navigate", `${SITE}/b`], ["browser_navigate", `${SITE}/a`])
  const { result } = await browse(calls, site, new OpenSession())
  expect(result).toMatchObject({ stopReason: "no_progress", steps: 8 })
})

it("stops a cycle between real fixture pages, ignoring fragments", async () => {
  const fixture = startFixtureServer()
  const browser = new BrowserSession({ headless: true })
  try {
    const model = scriptedModel([
      ...["/", "/pricing", "/#top", "/pricing", "/", "/pricing", "/#search", "/pricing", "/"].map((path, index) => () => ({
        toolCalls: [{ id: `${index + 1}`, name: "browser_navigate", arguments: { url: fixture.url + path } }],
      })),
      () => ({ text: "done", toolCalls: [] }),
    ])
    const result = await runAgent({ task: "t", browser, model })
    expect(result).toMatchObject({ status: "failed", stopReason: "no_progress", steps: 9, error: `Stopped after opening ${fixture.url}/ 5 times without finding anything new` })
  } finally {
    await browser.close()
    fixture.stop()
  }
}, 30_000)

it("stops a cycle through new URLs that show the same not-found page", async () => {
  const calls: Call[] = []
  for (let guess = 1; guess <= 4; guess++) calls.push(["browser_navigate", `${SITE}/a`], ["browser_navigate", `${SITE}/missing-${guess}`])
  calls.push(["browser_navigate", `${SITE}/a`])
  const { result } = await browse(calls, notFound)
  expect(result).toMatchObject({ status: "failed", stopReason: "no_progress", steps: 9, error: `Stopped after opening ${SITE}/a 5 times without finding anything new` })
})

it("does not count a list revisited between new detail pages under a large shared template", async () => {
  // Each product brings a dozen new lines, though they are under a third of its page.
  const calls: Call[] = [["browser_navigate", `${SITE}/list`]]
  for (let item = 1; item <= 6; item++) calls.push(["browser_click", `${SITE}/item/${item}`], ["browser_navigate", `${SITE}/list`])
  const { result } = await browse(calls, store)
  expect(result).toMatchObject({ status: "completed", stopReason: "final_answer", steps: 14 })
})

it("stops toggling a panel open and closed on one URL, though its refs change", async () => {
  const clicked: string[] = []
  const click = (name: RegExp) => (last: string) => {
    clicked.push(refFor(last, name))
    return { name: "browser_click", arguments: { ref: clicked.at(-1) } }
  }
  const { url, result } = await browseFixture("/filters", Array.from({ length: 4 }, () => [click(/button "Filter & Sort"/), click(/button "Close"/)]).flat())
  expect(result).toMatchObject({ status: "failed", stopReason: "no_progress", steps: 9, error: `Stopped after returning to the same state of ${url} 4 times without finding anything new` })
  // The panel is built again on every open, so each of its Close buttons had another ref.
  expect(new Set(clicked.filter((_, index) => index % 2)).size).toBe(4)
}, 30_000)

it("does not count returns to one tab between tabs that each show new content", async () => {
  // Each tab brings a dozen new lines, though they are under a third of the page.
  const calls: Call[] = [["browser_navigate", `${SITE}/product`]]
  for (const tab of TABS.slice(1)) calls.push(["browser_click", tab], ["browser_click", "Overview"])
  const { result } = await browse(calls, product)
  expect(result).toMatchObject({ status: "completed", stopReason: "final_answer", steps: 14 })
})

it("stops alternating text reads of two unchanged elements", async () => {
  let refs: string[] = []
  const read = (index: number) => (last: string) => {
    // A text read shows no refs, so both come from the page opened first.
    if (!refs.length) refs = [refFor(last, /heading "Pricing"/), refFor(last, /paragraph/)]
    return { name: "browser_get_text", arguments: { ref: refs[index % 2] } }
  }
  const { url, result } = await browseFixture("/pricing", Array.from({ length: 9 }, (_, index) => read(index)))
  expect(result).toMatchObject({ status: "failed", stopReason: "no_progress", steps: 10, error: `Stopped after reading the same text of ${url} 5 times without finding anything new` })
}, 30_000)

it("does not count a text read again between reads of new texts", async () => {
  const calls: Call[] = [["browser_navigate", `${SITE}/a`], ["browser_get_text", "summary"]]
  for (let card = 1; card <= 6; card++) calls.push(["browser_get_text", `card-${card}`], ["browser_get_text", "summary"])
  const { result } = await browse(calls)
  expect(result).toMatchObject({ status: "completed", stopReason: "final_answer", steps: 15 })
})

it("keeps counting page revisits between reads of text", async () => {
  // Text is formatted unlike snapshots, so a first read of a page seen before resets no page counts.
  const calls: Call[] = []
  for (const [index, path] of ["/a", "/b", "/a", "/b", "/a", "/b", "/a", "/b"].entries()) calls.push(["browser_navigate", `${SITE}${path}`], ["browser_get_text", `e${index}`])
  calls.push(["browser_navigate", `${SITE}/a`])
  const { result } = await browse(calls)
  expect(result).toMatchObject({ status: "failed", stopReason: "no_progress", steps: 17, error: `Stopped after opening ${SITE}/a 5 times without finding anything new` })
})

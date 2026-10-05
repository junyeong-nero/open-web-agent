import { expect, it } from "bun:test"
import { z } from "zod"
import { runAgent } from "./agent"
import { BrowserSession } from "./browser"
import { startFixtureServer } from "./testing/fixture"
import { scriptedModel } from "./testing/scripted-model"
import type { BrowserTool } from "./tools"

const SITE = "https://site.test"
type Page = (url: string, load: number) => { title: string; body: string }
type Call = [tool: string, url?: string]

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

/** Tools that move to `url` when given one and return the page in BrowserSession.snapshot() format. */
function fakeTools(page: Page): BrowserTool[] {
  let current = ""
  let load = 0
  return ["browser_navigate", "browser_click", "browser_go_back", "browser_scroll", "browser_wait_for"].map((name) => ({
    name, description: name, schema: z.object({ url: z.string().optional() }), readOnly: false, capability: "core",
    async run(_session, { url }) {
      if (url) current = url
      const { title, body } = page(current.replace(/#.*/, ""), ++load)
      return { text: `${name} ${current}`, snapshot: `Page URL: ${current}\nPage title: ${title}\nPage tab: t1\nSnapshot:\n${body}` }
    },
  }))
}

/** One tool call per step, then a final answer the run reaches unless it is stopped. */
function script(calls: Call[]) {
  return scriptedModel([
    ...calls.map(([name, url], index) => () => ({ toolCalls: [{ id: `${index + 1}`, name, arguments: url ? { url } : {} }] })),
    () => ({ text: "done", toolCalls: [] }),
  ])
}

async function browse(calls: Call[], page = site, browser = new BrowserSession({ headless: true })) {
  return { result: await runAgent({ task: "t", browser, model: script(calls), tools: fakeTools(page) }) }
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

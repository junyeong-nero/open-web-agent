import { expect, it } from "bun:test"
import { z } from "zod"
import { runAgent } from "./agent"
import { BrowserSession } from "./browser"
import { startFixtureServer } from "./testing/fixture"
import { scriptedModel } from "./testing/scripted-model"
import type { BrowserTool } from "./tools"

/** Like Allrecipes and UPS from a Korean IP: one answers HTTP 402, the other sends a file instead of a page. */
const ALLRECIPES = "https://www.allrecipes.com/recipe/14469/quinoa-salad/"
const UPS = "https://www.ups.com/us/en/shipping/rates"
const MISSING = "https://www.nyse.com/rule-605-files"
const FINAL = 'Search snippets only.\n{"outcome":"blocked","unfinished":["Read the recipe page"]}'
type Call = [tool: string, url?: string]

/** Tools that move to `url` when given one and return the page in BrowserSession.snapshot() format. */
function fakeTools(): BrowserTool[] {
  let current = ""
  return ["browser_navigate", "browser_click", "browser_go_back", "browser_scroll"].map((name) => ({
    name, description: name, schema: z.object({ url: z.string().optional() }), readOnly: false, capability: "core",
    async run(_session, { url }) {
      if (url === UPS) throw new Error("The server sent a file (content-type `application/blank`) instead of a web page; the browser cannot display it.")
      if (url) current = url
      const status = current === ALLRECIPES ? 402 : current === MISSING ? 404 : undefined
      return {
        text: `${name} ${current}${status ? `\nThe server responded with HTTP ${status}.` : ""}`,
        snapshot: `Page URL: ${current}\nPage title: ${current}\nPage tab: t1\nSnapshot:\n- heading "${current}" [level=1] [ref=e1]`,
      }
    },
  }))
}

/** One tool call per step, then a final answer, which a stopped run gets as its best-effort answer. */
async function browse(calls: Call[]) {
  const model = scriptedModel([
    ...calls.map(([name, url], index) => () => ({ toolCalls: [{ id: `${index + 1}`, name, arguments: url ? { url } : {} }] })),
    () => ({ text: FINAL, toolCalls: [] }),
  ])
  return runAgent({ task: "t", browser: new BrowserSession({ headless: true }), model, tools: fakeTools() })
}

/** `count` new Bing queries, numbered from `from`. */
const searches = (from: number, count: number) =>
  Array.from({ length: count }, (_, index): Call => ["browser_navigate", `https://www.bing.com/search?q=quinoa+${from + index}`])

it.each([["HTTP 402", ALLRECIPES], ["a file instead of a page", UPS]])("stops on the fifth new search result page in a row after %s, on any web search engine", async (_block, blocked) => {
  const result = await browse([
    ["browser_navigate", blocked],
    ["browser_navigate", "https://www.bing.com/search?q=quinoa+salad"],
    ["browser_navigate", "https://www.google.co.kr/search?q=quinoa+salad+reviews"],
    ["browser_navigate", "https://html.duckduckgo.com/html/?q=quinoa+salad+rating"],
    ["browser_navigate", "https://search.yahoo.com/search;_ylt=AwrE?p=quinoa+salad+allrecipes"],
    ["browser_navigate", "https://search.brave.com/search?q=quinoa+salad+500+reviews"],
  ])
  expect(result).toMatchObject({
    status: "failed", stopReason: "no_progress", steps: 6, error: "Stopped after opening 5 search result pages in a row since a site was blocked",
    answer: "Search snippets only.", outcome: { status: "blocked", unfinished: ["Read the recipe page"] },
  })
})

it("lets four new search result pages in a row and seven in total through, and stops on the eighth", async () => {
  const seven: Call[] = [["browser_navigate", ALLRECIPES], ...searches(1, 4), ["browser_click", "https://www.foodnetwork.com/recipes/quinoa-salad"], ...searches(5, 3)]
  expect(await browse(seven)).toMatchObject({ status: "completed", stopReason: "final_answer", steps: 10 })
  const eight = await browse([...seven, ["browser_click", "https://www.epicurious.com/recipes/quinoa-salad"], ...searches(8, 1)])
  expect(eight).toMatchObject({ status: "failed", stopReason: "no_progress", steps: 11, error: "Stopped after opening 8 search result pages since a site was blocked" })
})

it("counts only new web search result pages, and only after a block", async () => {
  // A 404 is not a block, so a long search is left to the model.
  expect(await browse([["browser_navigate", MISSING], ...searches(1, 8)])).toMatchObject({ status: "completed", stopReason: "final_answer", steps: 10 })
  const result = await browse([
    ["browser_navigate", ALLRECIPES],
    ...searches(1, 4),
    // Scrolled and re-opened result pages are not new.
    ["browser_scroll"],
    ["browser_go_back", "https://www.bing.com/search?q=quinoa+3"],
    // Other pages end a run of result pages and are not counted: a bot check, search engines' other pages, in-site searches.
    ["browser_navigate", "https://www.google.com/sorry/index?continue=https://www.google.com/search&q=EgQ"],
    ...searches(5, 3),
    ["browser_navigate", "https://www.google.com/maps?q=quinoa"],
    ["browser_navigate", "https://finance.yahoo.com/quote/AAPL?p=AAPL"],
    ["browser_navigate", "https://duckduckgo.com/"],
    ["browser_navigate", "https://brave.com/search/"],
    ["browser_navigate", "https://www.amazon.com/s?k=quinoa"],
    ["browser_navigate", "https://www.coursera.org/search?query=quinoa"],
  ])
  expect(result).toMatchObject({ status: "completed", stopReason: "final_answer", steps: 18 })
})

it("stops rewriting queries on a search engine whose results all point back to a 403 fixture page", async () => {
  const fixture = startFixtureServer()
  const browser = new BrowserSession({ headless: true })
  try {
    // A stand-in for Bing, served inside the browser: whatever the query, the only result is the blocked page.
    await (await browser.page()).route((url) => url.hostname === "www.bing.com", (route) => {
      const query = new URL(route.request().url()).searchParams.get("q")
      return route.fulfill({ contentType: "text/html", body: `<!doctype html><title>${query} - Search</title><h1>${query}</h1><a href="${fixture.url}/forbidden">Access denied</a>` })
    })
    // Rewrite the query while tools are offered, and answer when asked without them; unstopped, this runs into the step limit.
    const model = scriptedModel(Array.from({ length: 11 }, (_, index) => (request) => request.tools.length
      ? { toolCalls: [{ id: `${index + 1}`, name: "browser_navigate", arguments: { url: index ? `https://www.bing.com/search?q=quinoa+salad+${index}` : `${fixture.url}/forbidden` } }] }
      : { text: FINAL, toolCalls: [] }))
    const result = await runAgent({ task: "t", browser, model, maxSteps: 10 })
    expect(result).toMatchObject({
      status: "failed", stopReason: "no_progress", steps: 6, error: "Stopped after opening 5 search result pages in a row since a site was blocked",
      answer: "Search snippets only.", outcome: { status: "blocked" },
    })
    expect(model.requests.map((request) => request.tools.length > 0)).toEqual([true, true, true, true, true, true, false])
  } finally {
    await browser.close()
    fixture.stop()
  }
}, 30_000)

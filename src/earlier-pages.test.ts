import { expect, it } from "bun:test"
import { z } from "zod"
import { render, runAgent } from "./agent"
import { BrowserSession } from "./browser"
import type { Message } from "./model/types"
import { scriptedModel } from "./testing/scripted-model"
import type { BrowserTool } from "./tools"

type Entry = Parameters<typeof render>[0][number]

const task = "Compare the annual fees of the Amex Gold Card and the Platinum Card"
const dateLine = "Today is Saturday, 2026-10-10 (Asia/Seoul)."
const snapshotLabel = "[older snapshot, reduced to task-relevant lines; refs removed and not usable]"
const textLabel = "[older page text, reduced to task-relevant lines]"
const omittedSnapshot = "[older snapshot omitted: superseded by a newer one]"
const omittedText = "[older page text omitted: superseded by a newer read]"

/** A snapshot in the format of `BrowserSession.snapshot`. */
const snapshot = (url: string, title: string, lines: string[]) => `Page URL: ${url}\nPage title: ${title}\nPage tab: t1\nSnapshot:\n${lines.join("\n")}`
const menu = (from: number, count: number) => Array.from({ length: count }, (_, index) => `  - link "Menu link ${from + index}" [ref=e${from + index}] [cursor=pointer]`)
const gold = [
  '  - heading "American Express® Gold Card" [level=1] [ref=e900]',
  '  - paragraph [ref=e901]: "Annual Fee: $325"',
  '  - link "Apply now" [ref=e902] [cursor=pointer]:',
  "    - /url: https://cards.example/apply/gold-card-annual-fees",
]
const goldPage = snapshot("https://cards.example/gold", "Gold Card", [
  "- navigation [ref=e1]:", ...menu(10, 50), "  - paragraph [ref=e3]: Visit www.example.com", ...menu(60, 50), "- main [ref=e2]:", ...gold, ...menu(110, 100),
])
const platinumPage = snapshot("https://cards.example/platinum", "Platinum Card", ['- heading "The Platinum Card®" [level=1] [ref=e3]', '- paragraph [ref=e4]: "Annual Fee: $695"'])

const navigate = (id: string, page: string): Entry[] => [
  { role: "assistant", toolCalls: [{ id, name: "browser_navigate", arguments: {} }] },
  { role: "tool", toolCallId: id, name: "browser_navigate", result: { text: "Navigated", snapshot: page } },
]
const read = (id: string, text: string): Entry[] => [
  { role: "assistant", toolCalls: [{ id, name: "browser_get_text", arguments: {} }] },
  { role: "tool", toolCallId: id, name: "browser_get_text", result: { text, pageText: true } },
]
/** A short page at /<name>, which a digest keeps whole. */
const page = (name: string) => snapshot(`https://cards.example/${name}`, name, [`- paragraph [ref=e1]: The ${name} annual fee`])
const textOf = (message: Message) => message.role === "assistant" ? message.text ?? "" : message.content.map((part) => part.type === "text" ? part.text : "").join("\n")
/** The page state that a rendered tool message holds: its snapshot part, or the text of a text read. */
const pageOf = (message: Message) => message.role === "tool" && message.content.length > 1 ? textOf({ ...message, content: message.content.slice(1) }) : textOf(message)

it("keeps the task-relevant lines of an older text read", () => {
  const filler = Array.from({ length: 200 }, (_, index) => `Shop link ${index}`)
  const card = ["American Express® Gold Card", "Annual Fee: $325", "Earn 4X points at restaurants"]
  const messages = render([...read("1", [...filler.slice(0, 100), ...card, ...filler.slice(100)].join("\n")), ...read("2", "The Platinum Card® annual fee is $695.")], task)
  // The card name and the fee share rare words with the task, and the lines next to them come along.
  expect(textOf(messages[1]!)).toBe([textLabel, "…", filler[99], ...card, "…"].join("\n"))
  expect(textOf(messages[3]!)).toBe("The Platinum Card® annual fee is $695.")
})

it("keeps an older snapshot's URL, title and task-relevant lines, without refs, cursor hints or link URLs", () => {
  // The link's URL matches the task but only serves acting; "www.example.com" matches only the start URL, which is no task term.
  const start = `${task}. Start at https://www.example.com/.`
  const messages = render([{ role: "user", task: start, dateLine, snapshot: goldPage }, ...navigate("1", platinumPage)], start)
  expect(textOf(messages[0]!)).toBe([
    `${dateLine}\n\nTask: ${start}\n\nCurrent page:\n${snapshotLabel}`,
    "Page URL: https://cards.example/gold",
    "Page title: Gold Card",
    "…",
    "- main:",
    '  - heading "American Express® Gold Card" [level=1]',
    '  - paragraph: "Annual Fee: $325"',
    '  - link "Apply now":',
    "…",
  ].join("\n"))
  expect(pageOf(messages[2]!)).toBe(platinumPage)
})

it("caps each digest at 1,500 characters, label, URL and title included", () => {
  // Thirty long lines match "annual", too many to fit; a term on more lines than that would no longer count as rare.
  const lines = Array.from({ length: 300 }, (_, index) => index % 10 === 5
    ? `Annual fee tier ${index} costs $${index} a year, with the benefits of this tier listed in full`
    : `Shop link ${index}`)
  const tree = lines.map((line, index) => index % 10 === 5 ? `- paragraph [ref=e${index}]: ${line}` : `- link "${line}" [ref=e${index}] [cursor=pointer]`)
  const long = snapshot(`https://cards.example/${"x".repeat(3_000)}`, `Gold\nCard ${"y".repeat(500)}`, tree)
  const messages = render([
    ...navigate("1", long),
    ...read("2", lines.join("\n")),
    ...navigate("3", platinumPage),
    ...read("4", "The Platinum Card® annual fee is $695."),
  ], task)
  const [snapshotDigest, textDigest] = [pageOf(messages[1]!), textOf(messages[3]!)]
  expect(snapshotDigest).toStartWith(`${snapshotLabel}\nPage URL: https://cards.example/${"x".repeat(137)}…\nPage title: Gold Card ${"y".repeat(109)}…\n…\n`)
  expect(textDigest).toStartWith(`${textLabel}\n…\n`)
  for (const digest of [snapshotDigest, textDigest]) {
    expect(digest.length).toBeLessThanOrEqual(1_500)
    expect(digest.length).toBeGreaterThan(1_000)
    expect(digest).toContain("Annual fee tier 5 costs $5")
    expect(digest).not.toContain("[ref=")
  }
})

it("keeps digests only for the four newest superseded pages", () => {
  const entries = ["p1", "p2", "p3", "p4", "p5", "p6"].flatMap((name, index) => navigate(String(index), page(name)))
  const pages = render(entries, task).filter((message) => message.role === "tool").map(pageOf)
  expect(pages[0]).toBe(omittedSnapshot)
  for (const [index, name] of ["p2", "p3", "p4", "p5"].entries()) {
    expect(pages[index + 1]).toBe(`${snapshotLabel}\nPage URL: https://cards.example/${name}\nPage title: ${name}\n- paragraph: The ${name} annual fee`)
  }
  expect(pages[5]).toBe(page("p6"))
})

it("digests each URL or text once, and nothing that the newest snapshot or text read shows", () => {
  const entries = [
    ...navigate("1", page("a")),
    ...read("2", "Gold annual fee: $325"),
    ...navigate("3", page("b")),
    ...read("4", "Platinum annual fee: $695"),
    ...navigate("5", page("a")),
    ...read("6", "Gold annual fee: $325"),
    ...navigate("7", page("b")),
  ]
  const pages = render(entries, task).filter((message) => message.role === "tool").map(pageOf)
  expect(pages).toEqual([
    // The newer snapshot of /a and the newest text read cover the first two.
    omittedSnapshot,
    omittedText,
    // The newest snapshot shows /b.
    omittedSnapshot,
    `${textLabel}\nPlatinum annual fee: $695`,
    `${snapshotLabel}\nPage URL: https://cards.example/a\nPage title: a\n- paragraph: The a annual fee`,
    "Gold annual fee: $325",
    page("b"),
  ])
})

it("keeps the placeholder for a long page without task-relevant lines and for a snapshot without a page header", () => {
  const messages = render([
    ...navigate("1", "[Current page state unavailable. Previous snapshot refs may be stale.]"),
    ...read("2", Array.from({ length: 300 }, (_, index) => `Shop link ${index}`).join("\n")),
    ...navigate("3", platinumPage),
    ...read("4", "The Platinum Card® annual fee is $695."),
  ], task)
  expect(pageOf(messages[1]!)).toBe(omittedSnapshot)
  expect(textOf(messages[3]!)).toBe(omittedText)
})

it("renders the same entries the same way, and a new entry changes only older page state it supersedes", () => {
  const entries: Entry[] = [
    { role: "user", task, dateLine, snapshot: page("a") },
    ...navigate("1", page("b")),
    ...read("2", "Platinum annual fee: $695"),
    ...navigate("3", page("c")),
    // Back to /a: the current snapshot shows it, so its older digest goes.
    ...navigate("4", page("a")),
    ...navigate("5", page("d")),
    ...navigate("6", page("e")),
    // A fifth newer page pushes /b out of the four.
    ...navigate("7", page("f")),
    // The text read is older than the four newest superseded pages, so it gets no digest.
    ...read("8", "Gold annual fee: $325"),
  ]
  const copy = structuredClone(entries)
  const stage = (text: string) => text.includes("omitted: superseded") ? 2 : text.includes("reduced to task-relevant lines") ? 1 : 0
  // Indexes of the earlier messages that change when the entry at each index is added.
  const changed: Record<number, number[]> = {}
  for (let count = 1; count < entries.length; count++) {
    const before = render(entries.slice(0, count), task)
    const after = render(entries.slice(0, count + 1), task)
    expect(render(entries.slice(0, count + 1), task)).toEqual(after)
    const moved = before.flatMap((message, index) => Bun.deepEquals(message, after[index]) ? [] : [index])
    // Page state only moves from whole to digest to placeholder, so a message that changed never changes back.
    for (const index of moved) expect(stage(textOf(after[index]!))).toBeGreaterThan(stage(textOf(before[index]!)))
    if (moved.length) changed[count] = moved
  }
  expect(changed).toEqual({ 2: [0], 6: [2], 8: [0, 6], 10: [8], 12: [10], 14: [2, 12], 16: [4] })
  expect(entries).toEqual(copy)
})

it("starts each request with the previous one, byte for byte, up to the page state its step superseded", async () => {
  const pages: Record<string, string> = { gold: goldPage, platinum: platinumPage, c: page("c") }
  const texts: Record<string, string> = { gold: "Gold annual fee: $325", platinum: "Platinum annual fee: $695" }
  let current = ""
  const tools: BrowserTool[] = [
    {
      name: "browser_navigate", description: "test", schema: z.object({ url: z.string() }), readOnly: false, capability: "core",
      async run(_, { url }) { current = url; return { text: `Navigated to ${url}`, snapshot: pages[url] } },
    },
    {
      name: "browser_get_text", description: "test", schema: z.object({}), readOnly: true, capability: "core",
      async run() { return { text: texts[current]!, pageText: true } },
    },
  ]
  const call = (id: string, name: string, args: Record<string, unknown> = {}) => () => ({ toolCalls: [{ id, name, arguments: args }] })
  const model = scriptedModel([
    call("1", "browser_navigate", { url: "gold" }),
    call("2", "browser_get_text"),
    call("3", "browser_navigate", { url: "platinum" }),
    call("4", "browser_get_text"),
    call("5", "browser_navigate", { url: "c" }),
    () => ({ text: 'Gold: $325 a year. Platinum: $695 a year.\n{"outcome":"succeeded","unfinished":[]}', toolCalls: [] }),
  ])
  await runAgent({ task, model, browser: new BrowserSession({ headless: true }), tools })
  const requests = model.requests
  expect(new Set(requests.map((request) => request.cacheKey)).size).toBe(1)
  // Indexes of the messages of each request that the next request sends differently.
  const changed = requests.slice(1).map((next, index) => {
    const previous = requests[index]!
    expect(next.system).toBe(previous.system)
    expect(next.tools).toEqual(previous.tools)
    const moved = previous.messages.flatMap((message, at) => (JSON.stringify(message) === JSON.stringify(next.messages[at]) ? [] : [at]))
    // A changed message held the newest snapshot or text read, which the new step's own snapshot or text reduced.
    for (const at of moved) {
      expect(pageOf(previous.messages[at]!)).not.toStartWith("[older")
      expect(pageOf(next.messages[at]!)).toStartWith("[older")
    }
    return moved
  })
  // A snapshot supersedes the gold page, a text read its text, a snapshot the platinum page. A page pushed out of the
  // four digests, or shown again, also changes an older message (see the test above), which prompt caching cannot reuse.
  expect(changed).toEqual([[], [], [2], [4], [6]])
})

it("lets the model compare a page it left with the current one", async () => {
  const pages: Record<string, string> = { "https://cards.example/gold": goldPage, "https://cards.example/platinum": platinumPage }
  const open: BrowserTool = {
    name: "browser_navigate", description: "test", schema: z.object({ url: z.string() }), readOnly: false, capability: "core",
    async run(_, { url }) { return { text: `Navigated to ${url}`, snapshot: pages[url] } },
  }
  const go = (id: string, url: string) => () => ({ toolCalls: [{ id, name: "browser_navigate", arguments: { url } }] })
  const model = scriptedModel([
    go("1", "https://cards.example/gold"),
    go("2", "https://cards.example/platinum"),
    () => ({ text: 'Gold: $325 a year. Platinum: $695 a year.\n{"outcome":"succeeded","unfinished":[]}', toolCalls: [] }),
  ])
  const result = await runAgent({ task, model, browser: new BrowserSession({ headless: true }), tools: [open] })
  expect(result.answer).toBe("Gold: $325 a year. Platinum: $695 a year.")
  const last = model.requests.at(-1)!
  expect(last.system).toContain("Older ones from the last few pages are reduced to their task-relevant lines, without refs")
  expect(last.system).toContain("keep any other needed facts in a brief assistant note")
  const [left, current] = last.messages.filter((message) => message.role === "tool").map(pageOf)
  expect(left).toStartWith(`${snapshotLabel}\nPage URL: https://cards.example/gold\nPage title: Gold Card\n`)
  expect(left).toContain('  - paragraph: "Annual Fee: $325"')
  expect(left).not.toContain("[ref=")
  expect(left).not.toContain("/url:")
  expect(current).toBe(platinumPage)
})

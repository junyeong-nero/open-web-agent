import { afterAll, beforeAll, expect, it } from "bun:test"
import type { Page } from "playwright"
import { runAgent } from "./agent"
import { BrowserSession } from "./browser"
import { refFor, startFixtureServer } from "./testing/fixture"
import { scriptedModel } from "./testing/scripted-model"
import { callTool, selectTools } from "./tools"

const fixture = startFixtureServer()
const session = new BrowserSession({ headless: true })
const tools = selectTools()
const call = (name: string, args: unknown = {}) => callTool(tools, session, name, args)
/** The whole text that browser_get_text reads in parts. */
const textOf = async (selector: string) =>
  (await (await session.page()).locator(selector).innerText()).replace(/\n{3,}/g, "\n\n").trim()

beforeAll(async () => {
  await (await session.page()).goto(`${fixture.url}/article`)
}, 30_000)

afterAll(async () => {
  await session.close()
  fixture.stop()
})

it("reads past the length limit with the offset that each notice gives", async () => {
  const text = await textOf("body")
  expect(text.length).toBeGreaterThan(80_000)

  const first = await call("browser_get_text")
  expect(first).toEqual({
    pageText: true,
    text: `${text.slice(0, 40_000)}\n… [text truncated: showing chars 0–40000 of ${text.length}; call browser_get_text with offset=40000 to read more]`,
  })
  expect(first.text).not.toContain("Table 8")

  const second = await call("browser_get_text", { offset: 40_000 })
  expect(second).toEqual({
    pageText: true,
    text: `${text.slice(40_000, 80_000)}\n… [text truncated: showing chars 40000–80000 of ${text.length}; call browser_get_text with offset=80000 to read more]`,
  })
  expect(second.text).toContain("Table 8")

  expect(await call("browser_get_text", { offset: 80_000 })).toEqual({
    pageText: true,
    text: `${text.slice(80_000)}\n[end of text: showing chars 80000–${text.length} of ${text.length}]`,
  })
})

it("reads one element in parts by ref and leaves short text unchanged", async () => {
  const { snapshot = "" } = await call("browser_snapshot")
  expect(await call("browser_get_text", { ref: refFor(snapshot, /- banner \[/) })).toEqual({ pageText: true, text: "Site header" })

  const main = refFor(snapshot, /- main \[/)
  const text = await textOf("main")
  expect((await call("browser_get_text", { ref: main })).text).toEndWith(
    `\n… [text truncated: showing chars 0–40000 of ${text.length}; call browser_get_text with ref=${main} and offset=40000 to read more]`,
  )
  expect(await call("browser_get_text", { ref: main, offset: 80_000 })).toEqual({
    pageText: true,
    text: `${text.slice(80_000)}\n[end of text: showing chars 80000–${text.length} of ${text.length}]`,
  })
})

it("reports an offset at or past the end instead of returning empty text", async () => {
  const { length } = await textOf("body")
  for (const offset of [length, length + 1]) {
    expect(await call("browser_get_text", { offset })).toEqual({ text: `No text at offset=${offset}: the text is ${length} chars long.`, isError: true })
  }
  expect((await call("browser_get_text", { offset: -1 })).text).toContain("Invalid arguments for browser_get_text")
})

it("keeps only the newest part in agent context, and an out-of-range read does not replace it", async () => {
  const { length } = await textOf("body")
  const read = (id: string, args: Record<string, unknown>) => () => ({ toolCalls: [{ id, name: "browser_get_text", arguments: args }] })
  const model = scriptedModel([
    read("1", {}),
    read("2", { offset: 40_000 }),
    read("3", { offset: 1_000_000 }),
    () => ({ text: 'Eight tables\n{"outcome":"succeeded","unfinished":[]}', toolCalls: [] }),
  ])
  expect((await runAgent({ task: "Count the tables", model, browser: session })).stopReason).toBe("final_answer")

  const results = model.requests.at(-1)!.messages.flatMap((message) => message.role === "tool" ? [message.content.map((part) => part.type === "text" ? part.text : "").join("\n")] : [])
  expect(results.map((text) => text.split("\n").at(-1))).toEqual([
    "[older page text omitted: superseded by a newer read]",
    `… [text truncated: showing chars 40000–80000 of ${length}; call browser_get_text with offset=80000 to read more]`,
    `No text at offset=1000000: the text is ${length} chars long.`,
  ])
}, 30_000)

it("never splits a surrogate pair between parts", async () => {
  const stub = new BrowserSession({ maxSnapshotChars: 4 })
  stub.page = async () => ({ locator: () => ({ innerText: async () => "abc😀def" }) }) as unknown as Page
  const read = async (args: Record<string, unknown>) => (await callTool(tools, stub, "browser_get_text", args)).text
  expect(await read({})).toBe("abc😀\n… [text truncated: showing chars 0–5 of 8; call browser_get_text with offset=5 to read more]")
  expect(await read({ offset: 5 })).toBe("def\n[end of text: showing chars 5–8 of 8]")
  // An offset inside the pair starts at the whole character.
  expect(await read({ offset: 4 })).toBe("😀de\n… [text truncated: showing chars 3–7 of 8; call browser_get_text with offset=7 to read more]")
})

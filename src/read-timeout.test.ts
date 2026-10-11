import { afterAll, afterEach, expect, it, spyOn } from "bun:test"
import { BrowserSession } from "./browser"
import { runAgent } from "./agent"
import { refFor, startFixtureServer } from "./testing/fixture"
import { lastToolText, scriptedModel } from "./testing/scripted-model"
import { callTool, selectTools } from "./tools"

const fixture = startFixtureServer()
const tools = selectTools()
let session: BrowserSession
const snapshotNote = "The first snapshot attempt timed out; a second attempt succeeded."
const textNote = "Text was read without layout after a timeout, so it may include hidden text and lose line breaks."

afterEach(async () => { await session?.close() })
afterAll(() => fixture.stop())

async function ready(ms = 2000) {
  session = new BrowserSession({ headless: true, settleTimeoutMs: 0 })
  const page = await session.page()
  await page.goto(`${fixture.url}/busy-read?ms=${ms}`)
  const snapshot = await session.snapshot()
  // Only the operations under test get a short timeout, after the renderer is warm.
  const ariaSnapshot = page.ariaSnapshot.bind(page)
  spyOn(page, "ariaSnapshot").mockImplementation(options => ariaSnapshot({ ...options, timeout: options?.timeout ?? 100 }))
  const locator = page.locator.bind(page)
  spyOn(page, "locator").mockImplementation((selector, options) => {
    const target = locator(selector, options)
    const innerText = target.innerText.bind(target)
    target.innerText = options => innerText({ ...options, timeout: 100 })
    return target
  })
  const block = async () => {
    const started = page.waitForEvent("console", { predicate: message => message.text() === "renderer blocking" })
    await Promise.all([page.getByRole("button", { name: "Block renderer" }).click(), started])
  }
  return { page, block, snapshot }
}

it("retries an explicit snapshot after a renderer timeout", async () => {
  const { block } = await ready()
  await block()
  const result = await callTool(tools, session, "browser_snapshot", {})
  expect(result.isError).toBeUndefined()
  expect(result.text).toContain(snapshotNote)
  expect(result.snapshot).toContain("Visible text")
  expect((await callTool(tools, session, "browser_snapshot", {})).text).not.toContain(snapshotNote)
}, 30_000)

it("retries an action's follow-up snapshot", async () => {
  const { snapshot } = await ready(3000)
  const result = await callTool(tools, session, "browser_click", { ref: refFor(snapshot, /button "Block renderer"/) })
  expect(result.isError).toBeUndefined()
  expect(result.text).toContain(snapshotNote)
  expect(result.snapshot).toContain("Visible text")
}, 30_000)

it("reads text without layout after a timeout and keeps pagination", async () => {
  const { block } = await ready()
  session.options.maxSnapshotChars = 12
  await block()
  const result = await callTool(tools, session, "browser_get_text", { offset: 15 })
  expect(result.isError).toBeUndefined()
  expect(result.pageText).toBe(true)
  expect(result.text).toContain(textNote)
  expect(result.text).toContain("Visible text")
  expect(result.text).toContain("offset=27")
  await block()
  session.options.maxSnapshotChars = 40_000
  const all = await callTool(tools, session, "browser_get_text", {})
  expect(all.text).toContain("Hidden textLast line")
  expect(all.text).not.toContain("   ")
  expect(all.text).not.toContain("\n\n\n")
}, 30_000)

it.each(["browser_snapshot", "browser_get_text", "browser_select_tab"])("preserves the original failure when %s cannot recover", async name => {
  const { block } = await ready(9000)
  await block()
  const result = await callTool(tools, session, name, name === "browser_select_tab" ? { tabId: "t1" } : {})
  expect(result.text).toContain("Timeout 100ms exceeded")
  expect(result.text).not.toContain(snapshotNote)
  expect(result.text).not.toContain(textNote)
  if (name === "browser_select_tab") {
    expect(result.isError).toBeUndefined()
    expect(result.text).toContain("follow-up snapshot failed")
  } else expect(result.isError).toBe(true)
}, 30_000)

it.each(["browser_snapshot", "browser_get_text"])("does not count a recovered %s step as an agent failure", async name => {
  const { block } = await ready()
  const result = await runAgent({ browser: session, task: "Read the page", maxConsecutiveFailures: 1,
    model: scriptedModel([
      async () => { await block(); return { toolCalls: [{ id: "1", name, arguments: {} }] } },
      request => {
        expect(lastToolText(request.messages)).toContain(name === "browser_snapshot" ? snapshotNote : textNote)
        return { text: "Read the page", toolCalls: [] }
      },
    ]),
  })
  expect(result.stopReason).toBe("final_answer")
}, 30_000)

import { expect, it } from "bun:test"
import { errors, type Page } from "playwright"
import { BrowserSession } from "./browser"
import { callTool, selectTools } from "./tools"

const tools = selectTools()

it("does not retry non-timeout snapshot or text errors", async () => {
  const session = new BrowserSession()
  let snapshots = 0
  let fallbacks = 0
  session.page = async () => ({
    ariaSnapshot: async () => { snapshots++; throw new Error("snapshot unavailable") },
    locator: () => ({
      innerText: async () => { throw new Error("text unavailable") },
      textContent: async () => { fallbacks++; return "unexpected" },
    }),
  }) as unknown as Page
  expect((await callTool(tools, session, "browser_snapshot", {})).text).toContain("snapshot unavailable")
  expect((await callTool(tools, session, "browser_get_text", {})).text).toContain("text unavailable")
  expect(snapshots).toBe(1)
  expect(fallbacks).toBe(0)
})

it("preserves the original text error if the fallback fails", async () => {
  const session = new BrowserSession()
  session.page = async () => ({ locator: () => ({
    innerText: async () => { throw new errors.TimeoutError("original text timeout") },
    textContent: async ({ timeout }: { timeout: number }) => {
      expect(timeout).toBe(5000)
      throw new Error("fallback failed")
    },
  }) }) as unknown as Page
  const result = await callTool(tools, session, "browser_get_text", {})
  expect(result.isError).toBe(true)
  expect(result.text).toContain("original text timeout")
  expect(result.text).not.toContain("fallback failed")
})

it("cancels the snapshot retry wait without issuing another attempt", async () => {
  const session = new BrowserSession()
  let attempts = 0
  session.page = async () => ({ ariaSnapshot: async () => {
    attempts++
    throw new errors.TimeoutError("original snapshot timeout")
  } }) as unknown as Page
  const pending = callTool(tools, session, "browser_snapshot", {})
  // Let the rejected first attempt enter its retry wait.
  await new Promise(resolve => setTimeout(resolve, 20))
  const start = performance.now()
  await session.cancelPending(pending)
  expect(performance.now() - start).toBeLessThan(500)
  expect(attempts).toBe(1)
  expect((await pending).text).toContain("original snapshot timeout")
})

it("preserves the first snapshot timeout when the retry fails", async () => {
  const session = new BrowserSession()
  let attempts = 0
  session.page = async () => ({ ariaSnapshot: async (options: { timeout?: number }) => {
    if (++attempts === 1) throw new errors.TimeoutError("original snapshot timeout")
    expect(options.timeout).toBe(5000)
    throw new Error("retry failed")
  } }) as unknown as Page
  const result = await callTool(tools, session, "browser_snapshot", {})
  expect(attempts).toBe(2)
  expect(result.isError).toBe(true)
  expect(result.text).toContain("original snapshot timeout")
  expect(result.text).not.toContain("retry failed")
})

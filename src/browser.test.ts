import { expect, it } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BrowserSession } from "./browser"

it("preserves the context and closes its browser after replacing the last tab", async () => {
  const session = new BrowserSession({ headless: true })
  const page = await session.page()
  const context = page.context()
  const browser = context.browser()!
  try {
    const oldId = (await session.tabs())[0].id
    await context.addCookies([{ name: "session", value: "retained", domain: "example.com", path: "/" }])
    await page.close()
    const [next, concurrent] = await Promise.all([session.page(), session.page()])
    expect(next).toBe(concurrent)
    expect(next.context()).toBe(context)
    expect(context.pages()).toHaveLength(1)
    expect((await context.cookies())[0].value).toBe("retained")
    expect((await session.tabs())[0].id).not.toBe(oldId)
    await expect(session.selectTab(oldId)).rejects.toThrow("Unknown or closed tab")
    await session.close()
    expect(browser.isConnected()).toBe(false)
  } finally { await session.close(); await browser.close() }
}, 15_000)

it("reuses a live browser after its context closes and restarts a disconnected browser", async () => {
  const session = new BrowserSession({ headless: true })
  const first = await session.page()
  const browser = first.context().browser()!
  try {
    await first.context().close()
    const second = await session.page()
    expect(second.context()).not.toBe(first.context())
    expect(second.context().browser()).toBe(browser)
    await browser.close()
    const third = await session.page()
    expect(third.isClosed()).toBe(false)
    expect(third.context().browser()).not.toBe(browser)
  } finally { await session.close(); await browser.close() }
}, 15_000)

it("reuses a persistent profile context after its last tab closes", async () => {
  const profile = await mkdtemp(join(tmpdir(), "owa-profile-test-"))
  const session = new BrowserSession({ headless: true, userDataDir: profile })
  try {
    const page = await session.page()
    const context = page.context()
    await page.close()
    expect((await session.page()).context()).toBe(context)
  } finally { await session.close(); await rm(profile, { recursive: true, force: true }) }
}, 15_000)

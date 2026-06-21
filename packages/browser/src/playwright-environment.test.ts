import { describe, expect, it } from "bun:test"
import { mkdtemp, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { EventBus, type RuntimeContext } from "@open-web-agent/core"
import * as playwrightEnvironment from "./playwright-environment"
import { PlaywrightBrowserToolAdapter, PlaywrightEnvironment } from "./playwright-environment"

async function context(
  sessionId = "ses_1",
  runId = "run_1",
  abortSignal: AbortSignal = new AbortController().signal,
): Promise<RuntimeContext> {
  return {
    session: {
      id: sessionId,
      projectPath: "/tmp/project",
      projectHash: "hash",
      createdAt: "2026-06-17T00:00:00.000Z",
    },
    runId,
    runDir: await mkdtemp(join(tmpdir(), "owa-playwright-env-")),
    eventBus: new EventBus(),
    abortSignal,
    now: () => new Date("2026-06-17T00:00:00.000Z"),
    async emit() {
      throw new Error("not used")
    },
  }
}

function fixtureHtml(): string {
  return `<!doctype html>
    <html>
      <head><title>Playwright Fixture</title></head>
      <body>
        <button id="toggle">Reveal</button>
        <input id="name" aria-label="Name" />
        <input id="hidden-token" type="hidden" name="where" value="nexearch" />
        <button id="hidden-button" style="display: none">Hidden</button>
        <main id="status">Idle</main>
        <script>
          document.querySelector("#toggle").addEventListener("click", () => {
            document.querySelector("#status").textContent = "Revealed"
          })
          document.querySelector("#name").addEventListener("input", (event) => {
            document.querySelector("#status").textContent = "Typed " + event.target.value
          })
        </script>
      </body>
    </html>`
}

function startFixtureServer(): { url: string; stop(): void } {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(fixtureHtml(), { headers: { "content-type": "text/html" } }),
  })

  return {
    url: `http://127.0.0.1:${server.port}/`,
    stop: () => server.stop(true),
  }
}

interface FakePage {
  bringToFrontCalls: number
  closeCalls: number
  bringToFront(): Promise<void>
  close(): Promise<void>
}

interface FakeContext {
  pages: FakePage[]
  closeCalls: number
  newPage(): Promise<FakePage>
  close(): Promise<void>
}

function createFakePage(): FakePage {
  return {
    bringToFrontCalls: 0,
    closeCalls: 0,
    async bringToFront() {
      this.bringToFrontCalls += 1
    },
    async close() {
      this.closeCalls += 1
    },
  }
}

function createFakeContext(): FakeContext {
  return {
    pages: [],
    closeCalls: 0,
    async newPage() {
      const page = createFakePage()
      this.pages.push(page)
      return page
    },
    async close() {
      this.closeCalls += 1
      await Promise.all(this.pages.map((page) => page.close()))
    },
  }
}

function createFakeBrowser() {
  let closeCalls = 0
  let connected = true
  const contexts: FakeContext[] = []
  const browser = {
    isConnected() {
      return connected
    },
    async newContext() {
      const context = createFakeContext()
      contexts.push(context)
      return context
    },
    async close() {
      closeCalls += 1
      connected = false
    },
  }

  return {
    browser,
    contexts,
    closeCalls: () => closeCalls,
    disconnect: () => {
      connected = false
    },
  }
}

function stubBrowserLaunch(env: PlaywrightEnvironment, browser: unknown | Promise<unknown>): { launchCalls: () => number } {
  return stubBrowserLaunches(env, [browser])
}

function stubBrowserLaunches(
  env: PlaywrightEnvironment,
  browsers: Array<unknown | Promise<unknown>>,
): { launchCalls: () => number } {
  let launchCalls = 0
  ;(env as unknown as { launchBrowser(): Promise<unknown> }).launchBrowser = async () => {
    const browser = browsers[launchCalls]
    launchCalls += 1
    if (!browser) throw new Error(`unexpected browser launch ${launchCalls}`)
    return await browser
  }
  return { launchCalls: () => launchCalls }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((resolvePromise) => {
    resolve = () => resolvePromise()
  })
  return { promise, resolve }
}

function gateFakeNewPages(fake: ReturnType<typeof createFakeBrowser>) {
  const firstPageStarted = deferred()
  const releasePages = deferred()

  ;(fake.browser as { newContext(): Promise<FakeContext> }).newContext = async () => {
    const context = createFakeContext()
    const originalNewPage = context.newPage.bind(context)
    context.newPage = async () => {
      firstPageStarted.resolve()
      await releasePages.promise
      return originalNewPage()
    }
    fake.contexts.push(context)
    return context
  }

  return {
    firstPageStarted: firstPageStarted.promise,
    releasePages: () => releasePages.resolve(),
  }
}

describe("PlaywrightEnvironment", () => {
  it("uses headed browser launches by default", () => {
    expect("resolvePlaywrightHeadless" in playwrightEnvironment).toBe(true)
    expect(
      (playwrightEnvironment as typeof playwrightEnvironment & {
        resolvePlaywrightHeadless(options: { headless?: boolean }): boolean
      }).resolvePlaywrightHeadless({}),
    ).toBe(false)
  })

  it("adds the Chromium minimized startup flag when browser focus prevention is enabled", () => {
    expect("resolveChromiumLaunchOptions" in playwrightEnvironment).toBe(true)
    const resolveChromiumLaunchOptions = (
      playwrightEnvironment as typeof playwrightEnvironment & {
        resolveChromiumLaunchOptions(options: { headless?: boolean; preventFocus?: boolean }): {
          headless: boolean
          args?: string[]
        }
      }
    ).resolveChromiumLaunchOptions

    expect(resolveChromiumLaunchOptions({ preventFocus: true })).toEqual({
      headless: false,
      args: ["--start-minimized"],
    })
    expect(resolveChromiumLaunchOptions({ headless: true, preventFocus: true })).toEqual({ headless: true })
  })

  it("does not bring an existing page to the front when browser focus prevention is enabled", async () => {
    const env = new PlaywrightEnvironment({ preventFocus: true })
    const fake = createFakeBrowser()
    stubBrowserLaunch(env, fake.browser)
    const ctx = await context()

    await env.attachSession(ctx)

    expect(fake.contexts[0]?.pages[0]?.bringToFrontCalls).toBe(0)
  })

  it("launches one shared browser while keeping separate session contexts", async () => {
    const env = new PlaywrightEnvironment({ headless: true })
    const fake = createFakeBrowser()
    const launch = stubBrowserLaunch(env, fake.browser)
    const first = await context("ses_1", "run_1")
    const second = await context("ses_2", "run_2")

    await env.reset(first)
    await env.reset(second)

    expect(launch.launchCalls()).toBe(1)
    expect(fake.contexts).toHaveLength(2)
    expect(fake.contexts[0]?.pages).toHaveLength(1)
    expect(fake.contexts[1]?.pages).toHaveLength(1)
    expect(fake.contexts[0]?.pages[0]).not.toBe(fake.contexts[1]?.pages[0])
  })

  it("reattaches the same session without creating a new context or page", async () => {
    const env = new PlaywrightEnvironment({ headless: true })
    const fake = createFakeBrowser()
    const launch = stubBrowserLaunch(env, fake.browser)
    const ctx = await context("ses_1", "run_1")

    await env.openSession(ctx)
    await env.attachSession(ctx)

    expect(launch.launchCalls()).toBe(1)
    expect(fake.contexts).toHaveLength(1)
    expect(fake.contexts[0]?.pages).toHaveLength(1)
    expect(fake.contexts[0]?.pages[0]?.bringToFrontCalls).toBe(1)
  })

  it("replaces stale session state when the shared browser disconnects", async () => {
    const env = new PlaywrightEnvironment({ headless: true })
    const stale = createFakeBrowser()
    const fresh = createFakeBrowser()
    const launch = stubBrowserLaunches(env, [stale.browser, fresh.browser])
    const ctx = await context("ses_1", "run_1")

    await env.openSession(ctx)
    stale.disconnect()
    await env.attachSession(ctx)

    expect(launch.launchCalls()).toBe(2)
    expect(stale.contexts).toHaveLength(1)
    expect(stale.contexts[0]?.closeCalls).toBe(1)
    expect(fresh.contexts).toHaveLength(1)
    expect(fresh.contexts[0]?.pages).toHaveLength(1)
    expect(fresh.contexts[0]?.pages[0]?.bringToFrontCalls).toBe(1)

    await env.close(ctx)

    expect(fresh.contexts[0]?.closeCalls).toBe(1)
    expect(fresh.closeCalls()).toBe(1)
  })

  it("keeps the shared browser open until the final session closes", async () => {
    const env = new PlaywrightEnvironment({ headless: true })
    const fake = createFakeBrowser()
    stubBrowserLaunch(env, fake.browser)
    const first = await context("ses_1", "run_1")
    const second = await context("ses_2", "run_2")

    await env.reset(first)
    await env.reset(second)
    await env.close(first)

    expect(fake.contexts[0]?.closeCalls).toBe(1)
    expect(fake.contexts[1]?.closeCalls).toBe(0)
    expect(fake.closeCalls()).toBe(0)

    await env.close(second)

    expect(fake.contexts[1]?.closeCalls).toBe(1)
    expect(fake.closeCalls()).toBe(1)
  })

  it("coalesces concurrent session opens into one browser launch", async () => {
    const env = new PlaywrightEnvironment({ headless: true })
    const fake = createFakeBrowser()
    let resolveLaunch!: (browser: unknown) => void
    const pendingLaunch = new Promise<unknown>((resolve) => {
      resolveLaunch = resolve
    })
    const launch = stubBrowserLaunch(env, pendingLaunch)
    const first = await context("ses_1", "run_1")
    const second = await context("ses_2", "run_2")

    const firstOpen = env.reset(first)
    const secondOpen = env.reset(second)
    resolveLaunch(fake.browser)
    await Promise.all([firstOpen, secondOpen])

    expect(launch.launchCalls()).toBe(1)
    expect(fake.contexts).toHaveLength(2)
  })

  it("coalesces concurrent opens for the same session", async () => {
    const env = new PlaywrightEnvironment({ headless: true })
    const fake = createFakeBrowser()
    const gatedPages = gateFakeNewPages(fake)
    stubBrowserLaunch(env, fake.browser)
    const ctx = await context("ses_1", "run_1")

    const firstOpen = env.openSession(ctx)
    await gatedPages.firstPageStarted
    const secondOpen = env.openSession(ctx)
    gatedPages.releasePages()
    await Promise.all([firstOpen, secondOpen])

    expect(fake.contexts).toHaveLength(1)
    expect(fake.contexts[0]?.pages).toHaveLength(1)

    await env.close(ctx)

    expect(fake.contexts[0]?.closeCalls).toBe(1)
    expect(fake.closeCalls()).toBe(1)
  })

  it("keeps same-session coalesced opens alive when the initiating caller aborts", async () => {
    const env = new PlaywrightEnvironment({ headless: true })
    const fake = createFakeBrowser()
    let resolveLaunch!: (browser: unknown) => void
    const pendingLaunch = new Promise<unknown>((resolve) => {
      resolveLaunch = resolve
    })
    const launch = stubBrowserLaunch(env, pendingLaunch)
    const firstAbort = new AbortController()
    const first = await context("ses_1", "run_1", firstAbort.signal)
    const second = await context("ses_1", "run_2")

    const firstOpen = env.openSession(first)
    const secondOpen = env.openSession(second)
    const firstResult = firstOpen.then(
      () => null,
      (error: unknown) => error,
    )
    const secondResult = secondOpen.then(
      () => "opened",
      (error: unknown) => error,
    )

    firstAbort.abort()

    const firstError = await firstResult
    expect(firstError).toBeInstanceOf(DOMException)
    expect((firstError as DOMException).message).toBe("Run cancelled")

    resolveLaunch(fake.browser)

    expect(await secondResult).toBe("opened")
    expect(launch.launchCalls()).toBe(1)
    expect(fake.contexts).toHaveLength(1)
    expect(fake.contexts[0]?.pages).toHaveLength(1)

    await env.close(second)

    expect(fake.contexts[0]?.closeCalls).toBe(1)
    expect(fake.closeCalls()).toBe(1)
  })

  it("closes a pending same-session open", async () => {
    const env = new PlaywrightEnvironment({ headless: true })
    const fake = createFakeBrowser()
    const gatedPages = gateFakeNewPages(fake)
    stubBrowserLaunch(env, fake.browser)
    const ctx = await context("ses_1", "run_1")

    const opening = env.openSession(ctx)
    await gatedPages.firstPageStarted
    const closing = env.close(ctx)
    gatedPages.releasePages()
    await Promise.all([opening, closing])

    expect(fake.contexts).toHaveLength(1)
    expect(fake.contexts[0]?.closeCalls).toBe(1)
    expect(fake.closeCalls()).toBe(1)
    expect(() => env.pageForTools(ctx)).toThrow("PlaywrightEnvironment has not been opened for the session")
  })

  it("blocks local and private network navigation by default", async () => {
    const env = new PlaywrightEnvironment({ headless: true })
    const tools = new PlaywrightBrowserToolAdapter(env)
    const ctx = await context()

    const result = await tools.execute({ id: "tool_1", type: "navigate", url: "http://127.0.0.1/" }, ctx)

    expect(result).toMatchObject({
      ok: false,
      message: "Blocked unsafe navigation URL",
      metadata: { url: "http://127.0.0.1/" },
    })
  })

  it("navigates, interacts with a fixture page, observes text, and captures a screenshot", async () => {
    const env = new PlaywrightEnvironment({ headless: true })
    const tools = new PlaywrightBrowserToolAdapter(env, { allowPrivateNetworkNavigation: true })
    const ctx = await context()
    const fixture = startFixtureServer()

    try {
      await env.reset(ctx)
      await tools.execute({ id: "tool_1", type: "navigate", url: fixture.url }, ctx)
      await tools.execute(
        {
          id: "tool_2",
          type: "click",
          target: { selector: "#toggle", elementId: null, text: null, role: null, name: null, coordinates: null },
        },
        ctx,
      )
      await tools.execute(
        {
          id: "tool_3",
          type: "type",
          target: { selector: "#name", elementId: null, text: null, role: null, name: null, coordinates: null },
          value: "Ada",
        },
        ctx,
      )
      await tools.execute({ id: "tool_4", type: "wait", ms: 1 }, ctx)
      const screenshot = await tools.execute({ id: "tool_5", type: "screenshot" }, ctx)
      const text = await tools.execute({ id: "tool_6", type: "extract_text" }, ctx)
      const observation = await env.observe(ctx)

      expect(observation.title).toBe("Playwright Fixture")
      expect(observation.text).toContain("Typed Ada")
      expect(observation.interactiveElements.some((element) => element.selector === "#toggle")).toBe(true)
      expect(observation.interactiveElements.some((element) => element.selector === "#name")).toBe(true)
      expect(observation.interactiveElements.some((element) => element.selector === "#hidden-token")).toBe(false)
      expect(observation.interactiveElements.some((element) => element.selector === "#hidden-button")).toBe(false)
      expect(text.metadata.text).toContain("Typed Ada")
      expect(screenshot.observation?.screenshotPath).toEndWith(".png")
      expect((await stat(screenshot.observation?.screenshotPath ?? "")).isFile()).toBe(true)
    } finally {
      fixture.stop()
      await env.close(ctx)
    }
  })
})

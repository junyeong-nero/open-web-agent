import { describe, expect, it } from "bun:test"
import { mkdtemp, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { EventBus, type RuntimeContext } from "@open-web-agent/core"
import { errors } from "playwright"
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
    browserCapabilities: ["core"],
    browserTools: [],
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
        <form action="/submitted">
          <input id="search" aria-label="Search" />
          <button id="submit" type="submit">Submit</button>
        </form>
        <a id="destination" href="/submitted">Destination</a>
        <input id="name" aria-label="Name" />
        <input id="password" type="password" value="initial-secret" />
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
    async fetch(request) {
      const url = new URL(request.url)
      if (url.pathname === "/submitted") {
        await Bun.sleep(50)
        return new Response(
          "<!doctype html><html><head><title>Submitted</title></head><body>Submitted destination</body></html>",
          { headers: { "content-type": "text/html" } },
        )
      }
      return new Response(fixtureHtml(), { headers: { "content-type": "text/html" } })
    },
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

const observationSnapshot = {
  url: "https://example.com/result",
  title: "Result",
  text: "Stable result",
  interactiveElements: [],
}

function installObservationPage(
  env: PlaywrightEnvironment,
  ctx: RuntimeContext,
  options: {
    evaluate(): Promise<typeof observationSnapshot>
    waitForLoadState?(): Promise<void>
  },
): { evaluateCalls: () => number; loadStateCalls: () => number } {
  let evaluateCalls = 0
  let loadStateCalls = 0
  const page = {
    async title() {
      return observationSnapshot.title
    },
    locator() {
      return {
        async innerText() {
          return observationSnapshot.text
        },
      }
    },
    url() {
      return observationSnapshot.url
    },
    async evaluate() {
      evaluateCalls += 1
      return options.evaluate()
    },
    async waitForLoadState() {
      loadStateCalls += 1
      await options.waitForLoadState?.()
    },
  }

  ;(
    env as unknown as {
      browser: { isConnected(): boolean; close(): Promise<void> }
      sessions: Map<
        string,
        {
          context: { close(): Promise<void> }
          page: typeof page
          lastScreenshotPath: string | null
          screenshotCount: number
        }
      >
    }
  ).browser = { isConnected: () => true, async close() {} }
  ;(
    env as unknown as {
      sessions: Map<
        string,
        {
          context: { close(): Promise<void> }
          page: typeof page
          lastScreenshotPath: string | null
          screenshotCount: number
        }
      >
    }
  ).sessions.set(ctx.session.id, {
    context: { async close() {} },
    page,
    lastScreenshotPath: null,
    screenshotCount: 0,
  })

  return {
    evaluateCalls: () => evaluateCalls,
    loadStateCalls: () => loadStateCalls,
  }
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
  it("exposes the browser tools it can execute", () => {
    const tools = new PlaywrightBrowserToolAdapter(new PlaywrightEnvironment({ headless: true })).listTools(["core"])

    expect(tools.map((tool) => tool.type)).toEqual([
      "navigate",
      "click",
      "type",
      "scroll",
      "wait",
      "press_key",
      "screenshot",
      "extract_text",
      "go_back",
      "go_forward",
    ])
    expect(tools.find((tool) => tool.type === "navigate")).toMatchObject({
      name: "browser_navigate",
      capability: "core",
      description: "Open an absolute HTTP(S) URL in the current browser page.",
      inputSchema: {
        type: "object",
        required: ["url"],
        additionalProperties: false,
      },
      readOnly: false,
      requiresApproval: false,
      parameters: [{ name: "url", type: "string", required: true, description: "Absolute HTTP(S) URL to open." }],
      example: { id: "tool_1", type: "navigate", url: "https://example.com" },
    })
    expect(tools.find((tool) => tool.type === "click")).toMatchObject({
      parameters: [{ name: "target", type: "ActionTarget", required: true }],
    })
  })

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

  it("closes the session when a browser tool is aborted", async () => {
    const abort = new AbortController()
    const ctx = await context("ses_1", "run_1", abort.signal)
    let closeCalls = 0
    let wheelStarted!: () => void
    const wheelStartedPromise = new Promise<void>((resolve) => {
      wheelStarted = resolve
    })
    const environment = {
      pageForTools: () => ({
        mouse: {
          wheel: () =>
            new Promise<void>(() => {
              wheelStarted()
            }),
        },
      }),
      close: async () => {
        closeCalls += 1
      },
      observe: async () => null,
    }
    const tools = new PlaywrightBrowserToolAdapter(environment as unknown as PlaywrightEnvironment)

    const result = tools.execute({ id: "tool_1", type: "scroll", deltaX: 0, deltaY: 100 }, ctx)
    await wheelStartedPromise
    abort.abort()

    await expect(result).rejects.toThrow("Run cancelled")
    expect(closeCalls).toBe(1)
  })

  it("retries an observation after a navigation destroys the execution context", async () => {
    const env = new PlaywrightEnvironment({ headless: true })
    const ctx = await context()
    let failuresRemaining = 1
    const calls = installObservationPage(env, ctx, {
      async evaluate() {
        if (failuresRemaining > 0) {
          failuresRemaining -= 1
          throw new Error("evaluate: Execution context was destroyed, most likely because of a navigation")
        }
        return observationSnapshot
      },
    })

    const observation = await env.observe(ctx)

    expect(observation).toMatchObject(observationSnapshot)
    expect(calls.evaluateCalls()).toBe(2)
    expect(calls.loadStateCalls()).toBe(1)
  })

  it("stops retrying an observation after three navigation-context failures", async () => {
    const env = new PlaywrightEnvironment({ headless: true })
    const ctx = await context()
    const calls = installObservationPage(env, ctx, {
      async evaluate() {
        throw new Error("evaluate: Cannot find context with specified id")
      },
    })

    await expect(env.observe(ctx)).rejects.toThrow("Cannot find context with specified id")
    expect(calls.evaluateCalls()).toBe(3)
    expect(calls.loadStateCalls()).toBe(2)
  })

  it("does not retry non-navigation observation failures", async () => {
    const env = new PlaywrightEnvironment({ headless: true })
    const ctx = await context()
    const calls = installObservationPage(env, ctx, {
      async evaluate() {
        throw new Error("evaluate: fixture exploded")
      },
    })

    await expect(env.observe(ctx)).rejects.toThrow("fixture exploded")
    expect(calls.evaluateCalls()).toBe(1)
    expect(calls.loadStateCalls()).toBe(0)
  })

  it("cancels while waiting to retry an observation", async () => {
    const abort = new AbortController()
    const ctx = await context("ses_1", "run_1", abort.signal)
    const env = new PlaywrightEnvironment({ headless: true })
    installObservationPage(env, ctx, {
      async evaluate() {
        throw new Error("evaluate: Execution context was destroyed, most likely because of a navigation")
      },
      async waitForLoadState() {
        await new Promise<void>(() => {})
      },
    })

    const observation = env.observe(ctx)
    setTimeout(() => abort.abort(), 5)

    await expect(observation).rejects.toThrow("Run cancelled")
  })

  it("clicks fixture elements by DOM elementId target", async () => {
    const env = new PlaywrightEnvironment({ headless: true })
    const tools = new PlaywrightBrowserToolAdapter(env, { allowPrivateNetworkNavigation: true })
    const ctx = await context()
    const fixture = startFixtureServer()

    try {
      await env.reset(ctx)
      await tools.execute({ id: "tool_1", type: "navigate", url: fixture.url }, ctx)
      const result = await tools.execute(
        {
          id: "tool_2",
          type: "click",
          target: { elementId: "toggle", selector: null, text: null, role: null, name: null, coordinates: null },
        },
        ctx,
      )

      expect(result.ok).toBe(true)
      expect(result.observation?.text).toContain("Revealed")
    } finally {
      fixture.stop()
      await env.close(ctx)
    }
  })

  it("waits for form navigation triggered by pressing Enter", async () => {
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
          type: "type",
          target: { selector: "#search", elementId: null, text: null, role: null, name: null, coordinates: null },
          value: "weather",
        },
        ctx,
      )

      const result = await tools.execute({ id: "tool_3", type: "press_key", key: "Enter" }, ctx)

      expect(result.ok).toBe(true)
      expect(result.observation?.url).toContain("/submitted")
      expect(result.observation?.title).toBe("Submitted")
      expect(result.observation?.text).toContain("Submitted destination")
    } finally {
      fixture.stop()
      await env.close(ctx)
    }
  })

  it("uses the focused locator for key presses", async () => {
    const env = new PlaywrightEnvironment({ headless: true })
    const tools = new PlaywrightBrowserToolAdapter(env, { allowPrivateNetworkNavigation: true })
    const ctx = await context()
    const fixture = startFixtureServer()

    try {
      await env.reset(ctx)
      await tools.execute({ id: "tool_1", type: "navigate", url: fixture.url }, ctx)
      const page = env.pageForTools(ctx)
      await page.locator("#name").focus()
      const originalPress = page.keyboard.press.bind(page.keyboard)
      ;(page.keyboard as unknown as { press(): Promise<void> }).press = async () => {
        throw new Error("raw keyboard press should not be used")
      }

      try {
        const result = await tools.execute({ id: "tool_2", type: "press_key", key: "A" }, ctx)
        expect(result.ok).toBe(true)
        expect(result.observation?.text).toContain("Typed A")
      } finally {
        ;(page.keyboard as unknown as { press: typeof originalPress }).press = originalPress
      }
    } finally {
      fixture.stop()
      await env.close(ctx)
    }
  })

  it("checks document readiness after a focused key press", async () => {
    const env = new PlaywrightEnvironment({ headless: true })
    const tools = new PlaywrightBrowserToolAdapter(env, { allowPrivateNetworkNavigation: true })
    const ctx = await context()
    const fixture = startFixtureServer()

    try {
      await env.reset(ctx)
      await tools.execute({ id: "tool_1", type: "navigate", url: fixture.url }, ctx)
      const page = env.pageForTools(ctx)
      await page.locator("#name").focus()
      const originalWaitForLoadState = page.waitForLoadState.bind(page)
      let readinessChecks = 0
      ;(page as unknown as { waitForLoadState(): Promise<void> }).waitForLoadState = async () => {
        readinessChecks += 1
        await originalWaitForLoadState("domcontentloaded")
      }

      try {
        await tools.execute({ id: "tool_2", type: "press_key", key: "A" }, ctx)
        expect(readinessChecks).toBe(1)
      } finally {
        ;(page as unknown as { waitForLoadState: typeof originalWaitForLoadState }).waitForLoadState =
          originalWaitForLoadState
      }
    } finally {
      fixture.stop()
      await env.close(ctx)
    }
  })

  it("waits for navigation triggered by a locator click", async () => {
    const env = new PlaywrightEnvironment({ headless: true })
    const tools = new PlaywrightBrowserToolAdapter(env, { allowPrivateNetworkNavigation: true })
    const ctx = await context()
    const fixture = startFixtureServer()

    try {
      await env.reset(ctx)
      await tools.execute({ id: "tool_1", type: "navigate", url: fixture.url }, ctx)
      const result = await tools.execute(
        {
          id: "tool_2",
          type: "click",
          target: { selector: "#destination", elementId: null, text: null, role: null, name: null, coordinates: null },
        },
        ctx,
      )

      expect(result.observation?.title).toBe("Submitted")
      expect(result.observation?.url).toContain("/submitted")
    } finally {
      fixture.stop()
      await env.close(ctx)
    }
  })

  it("checks document readiness after a locator click", async () => {
    const env = new PlaywrightEnvironment({ headless: true })
    const tools = new PlaywrightBrowserToolAdapter(env, { allowPrivateNetworkNavigation: true })
    const ctx = await context()
    const fixture = startFixtureServer()

    try {
      await env.reset(ctx)
      await tools.execute({ id: "tool_1", type: "navigate", url: fixture.url }, ctx)
      const page = env.pageForTools(ctx)
      const originalWaitForLoadState = page.waitForLoadState.bind(page)
      let readinessChecks = 0
      ;(page as unknown as { waitForLoadState(): Promise<void> }).waitForLoadState = async () => {
        readinessChecks += 1
        await originalWaitForLoadState("domcontentloaded")
      }

      try {
        await tools.execute(
          {
            id: "tool_2",
            type: "click",
            target: { selector: "#toggle", elementId: null, text: null, role: null, name: null, coordinates: null },
          },
          ctx,
        )
        expect(readinessChecks).toBe(1)
      } finally {
        ;(page as unknown as { waitForLoadState: typeof originalWaitForLoadState }).waitForLoadState =
          originalWaitForLoadState
      }
    } finally {
      fixture.stop()
      await env.close(ctx)
    }
  })

  it("preserves viewport coordinates while waiting for element navigation", async () => {
    const env = new PlaywrightEnvironment({ headless: true })
    const tools = new PlaywrightBrowserToolAdapter(env, { allowPrivateNetworkNavigation: true })
    const ctx = await context()
    const fixture = startFixtureServer()

    try {
      await env.reset(ctx)
      await tools.execute({ id: "tool_1", type: "navigate", url: fixture.url }, ctx)
      const page = env.pageForTools(ctx)
      const box = await page.locator("#destination").boundingBox()
      expect(box).not.toBeNull()
      const originalClick = page.mouse.click.bind(page.mouse)
      ;(page.mouse as unknown as { click(): Promise<void> }).click = async () => {
        throw new Error("raw mouse click should not be used")
      }

      try {
        const result = await tools.execute(
          {
            id: "tool_2",
            type: "click",
            target: {
              selector: null,
              elementId: null,
              text: null,
              role: null,
              name: null,
              coordinates: { x: (box?.x ?? 0) + 2, y: (box?.y ?? 0) + 2 },
            },
          },
          ctx,
        )

        expect(result.observation?.title).toBe("Submitted")
        expect(result.observation?.url).toContain("/submitted")
      } finally {
        ;(page.mouse as unknown as { click: typeof originalClick }).click = originalClick
      }
    } finally {
      fixture.stop()
      await env.close(ctx)
    }
  })

  it("waits for navigation from the raw coordinate-click fallback", async () => {
    const env = new PlaywrightEnvironment({ headless: true })
    const tools = new PlaywrightBrowserToolAdapter(env, { allowPrivateNetworkNavigation: true })
    const ctx = await context()
    const fixture = startFixtureServer()

    try {
      await env.reset(ctx)
      await tools.execute({ id: "tool_1", type: "navigate", url: fixture.url }, ctx)
      const page = env.pageForTools(ctx)
      const originalEvaluateHandle = page.evaluateHandle.bind(page)
      const originalClick = page.mouse.click.bind(page.mouse)
      ;(page as unknown as { evaluateHandle(): Promise<unknown> }).evaluateHandle = async () => ({
        asElement: () => null,
        async dispose() {},
      })
      ;(page.mouse as unknown as { click(): Promise<void> }).click = async () => {
        setTimeout(() => {
          void page.goto(`${fixture.url}submitted`, { waitUntil: "domcontentloaded" })
        }, 10)
      }

      try {
        const result = await tools.execute(
          {
            id: "tool_2",
            type: "click",
            target: {
              selector: null,
              elementId: null,
              text: null,
              role: null,
              name: null,
              coordinates: { x: 1, y: 1 },
            },
          },
          ctx,
        )
        expect(result.observation?.title).toBe("Submitted")
        expect(result.observation?.url).toContain("/submitted")
      } finally {
        ;(page as unknown as { evaluateHandle: typeof originalEvaluateHandle }).evaluateHandle = originalEvaluateHandle
        ;(page.mouse as unknown as { click: typeof originalClick }).click = originalClick
      }
    } finally {
      fixture.stop()
      await env.close(ctx)
    }
  })

  it("propagates document readiness timeouts after raw coordinate navigation starts", async () => {
    const env = new PlaywrightEnvironment({ headless: true })
    const tools = new PlaywrightBrowserToolAdapter(env, { allowPrivateNetworkNavigation: true })
    const ctx = await context()
    const fixture = startFixtureServer()

    try {
      await env.reset(ctx)
      await tools.execute({ id: "tool_1", type: "navigate", url: fixture.url }, ctx)
      const page = env.pageForTools(ctx)
      const originalEvaluateHandle = page.evaluateHandle.bind(page)
      const originalClick = page.mouse.click.bind(page.mouse)
      const originalWaitForEvent = page.waitForEvent.bind(page)
      const originalWaitForLoadState = page.waitForLoadState.bind(page)
      ;(page as unknown as { evaluateHandle(): Promise<unknown> }).evaluateHandle = async () => ({
        asElement: () => null,
        async dispose() {},
      })
      ;(page.mouse as unknown as { click(): Promise<void> }).click = async () => {}
      ;(page as unknown as { waitForEvent(): Promise<unknown> }).waitForEvent = async () => page.mainFrame()
      ;(page as unknown as { waitForLoadState(): Promise<void> }).waitForLoadState = async () => {
        throw new errors.TimeoutError("document readiness timed out")
      }

      try {
        await expect(
          tools.execute(
            {
              id: "tool_2",
              type: "click",
              target: {
                selector: null,
                elementId: null,
                text: null,
                role: null,
                name: null,
                coordinates: { x: 1, y: 1 },
              },
            },
            ctx,
          ),
        ).rejects.toThrow("document readiness timed out")
      } finally {
        ;(page as unknown as { evaluateHandle: typeof originalEvaluateHandle }).evaluateHandle = originalEvaluateHandle
        ;(page.mouse as unknown as { click: typeof originalClick }).click = originalClick
        ;(page as unknown as { waitForEvent: typeof originalWaitForEvent }).waitForEvent = originalWaitForEvent
        ;(page as unknown as { waitForLoadState: typeof originalWaitForLoadState }).waitForLoadState =
          originalWaitForLoadState
      }
    } finally {
      fixture.stop()
      await env.close(ctx)
    }
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
      const passwordType = await tools.execute(
        {
          id: "tool_4",
          type: "type",
          target: { selector: "#password", elementId: null, text: null, role: null, name: null, coordinates: null },
          value: "new-secret",
        },
        ctx,
      )
      await tools.execute({ id: "tool_5", type: "wait", ms: 1 }, ctx)
      const screenshot = await tools.execute({ id: "tool_6", type: "screenshot" }, ctx)
      const text = await tools.execute({ id: "tool_7", type: "extract_text" }, ctx)
      const observation = await env.observe(ctx)
      const serialized = JSON.stringify(observation)
      const password = observation.interactiveElements.find((element) => element.selector === "#password")

      expect(observation.title).toBe("Playwright Fixture")
      expect(observation.text).toContain("Typed Ada")
      expect(observation.interactiveElements.some((element) => element.selector === "#toggle")).toBe(true)
      expect(observation.interactiveElements.some((element) => element.selector === "#name")).toBe(true)
      expect(observation.interactiveElements.some((element) => element.selector === "#hidden-token")).toBe(false)
      expect(observation.interactiveElements.some((element) => element.selector === "#hidden-button")).toBe(false)
      expect(password?.name).toBe("[redacted]")
      expect(password?.attributes.value).toBe("[redacted]")
      expect(serialized).not.toContain("initial-secret")
      expect(serialized).not.toContain("new-secret")
      expect(passwordType.metadata.value).toBe("[redacted]")
      expect(JSON.stringify(passwordType)).not.toContain("new-secret")
      expect(text.metadata.text).toContain("Typed Ada")
      expect(screenshot.observation?.screenshotPath).toEndWith(".png")
      expect((await stat(screenshot.observation?.screenshotPath ?? "")).isFile()).toBe(true)
    } finally {
      fixture.stop()
      await env.close(ctx)
    }
  })
})

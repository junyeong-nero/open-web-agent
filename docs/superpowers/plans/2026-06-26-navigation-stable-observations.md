# Navigation-Stable Browser Observations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Return a stable per-tool browser observation across main-frame navigations and eliminate the orchestrator's duplicate post-action observation.

**Architecture:** `PlaywrightEnvironment` will atomically capture all document-derived observation fields and retry only transient navigation-context failures. `PlaywrightBrowserToolAdapter` will prefer locator/element actions that participate in Playwright navigation auto-waiting, with a bounded watcher only for raw mouse fallback. `RunOrchestrator` will promote the latest non-null `ActionResult.observation` to `lastObservation` and call the environment only when no tool result supplied one.

**Tech Stack:** Bun, strict TypeScript, Playwright 1.61, Zod-derived core contracts, `bun:test`.

---

## File Structure

- Modify: `packages/browser/src/playwright-environment.ts`
  - Replace the split `title()`/`innerText()`/`evaluate()` observation with one page evaluation.
  - Add bounded retry for destroyed execution contexts caused by navigation.
  - Use focused locator `press()` for key input.
  - Resolve coordinate clicks to an element action where possible.
  - Add a bounded main-frame watcher for raw mouse fallback.

- Modify: `packages/browser/src/playwright-environment.test.ts`
  - Extend the fixture server with delayed navigation routes.
  - Add deterministic retry classification and retry-limit tests.
  - Add real Playwright regression tests for Enter, link, and coordinate navigation.
  - Preserve abort, redaction, screenshot, and ordinary interaction coverage.

- Modify: `packages/core/src/orchestrator/run-orchestrator.ts`
  - Return the newest tool-result observation from `executeBrowserActions()`.
  - Reuse it as `state.lastObservation`.
  - Keep one fallback environment observation when results do not contain one.

- Modify: `packages/core/src/orchestrator/run-orchestrator.test.ts`
  - Count environment observation calls.
  - Prove tool-result observation reuse.
  - Prove fallback behavior for null tool observations.

No contract or schema files change.

---

### Task 1: Make Observation Capture Atomic and Navigation-Aware

**Files:**
- Modify: `packages/browser/src/playwright-environment.test.ts`
- Modify: `packages/browser/src/playwright-environment.ts`

- [ ] **Step 1: Add deterministic observation-page test helpers**

Add these helpers below `deferred()` in `packages/browser/src/playwright-environment.test.ts`:

```ts
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
```

- [ ] **Step 2: Add failing retry and classification tests**

Add these tests before the existing real-browser fixture tests:

```ts
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
    const waitStarted = deferred()
    installObservationPage(env, ctx, {
      async evaluate() {
        throw new Error("evaluate: Execution context was destroyed, most likely because of a navigation")
      },
      async waitForLoadState() {
        waitStarted.resolve()
        await new Promise<void>(() => {})
      },
    })

    const observation = env.observe(ctx)
    await waitStarted.promise
    abort.abort()

    await expect(observation).rejects.toThrow("Run cancelled")
  })
```

- [ ] **Step 3: Run the tests and verify the expected failure**

Run:

```bash
OPEN_WEB_AGENT_BROWSER_HEADLESS=true bun test packages/browser/src/playwright-environment.test.ts -t "observation"
```

Expected: FAIL because `readObservation()` performs no retry and the fake snapshot does not match the current split observation implementation.

- [ ] **Step 4: Replace split observation capture with an atomic snapshot**

In `packages/browser/src/playwright-environment.ts`, add these module constants after `PlaywrightSessionState`:

```ts
const OBSERVATION_CAPTURE_ATTEMPTS = 3
const NAVIGATION_CONTEXT_ERROR_PATTERNS = [
  "Execution context was destroyed",
  "Cannot find context with specified id",
]
```

Replace `readObservation()` with:

```ts
  private async readObservation(state: PlaywrightSessionState): Promise<Observation> {
    const { page } = state

    for (let attempt = 1; attempt <= OBSERVATION_CAPTURE_ATTEMPTS; attempt += 1) {
      try {
        const snapshot = await page.evaluate(() => {
          const candidates: Array<{ element: HTMLElement; rect: DOMRect }> = []
          const elements = Array.from(
            document.querySelectorAll<HTMLElement>(
              "a,button,input,textarea,select,[role],[tabindex],[contenteditable='true']",
            ),
          )

          for (const element of elements) {
            const rect = element.getBoundingClientRect()
            const style = window.getComputedStyle(element)
            const isHiddenInput = element instanceof HTMLInputElement && element.type === "hidden"
            const isVisible =
              !isHiddenInput &&
              !element.hidden &&
              element.getAttribute("aria-hidden") !== "true" &&
              style.display !== "none" &&
              style.visibility !== "hidden" &&
              style.visibility !== "collapse" &&
              rect.width > 0 &&
              rect.height > 0 &&
              rect.bottom > 0 &&
              rect.right > 0 &&
              rect.top < window.innerHeight &&
              rect.left < window.innerWidth

            if (!isVisible) continue
            candidates.push({ element, rect })
            if (candidates.length >= 50) break
          }

          return {
            url: window.location.href,
            title: document.title || null,
            text: document.body?.innerText ?? null,
            interactiveElements: candidates.map(({ element, rect }, index) => {
              const attributes: Record<string, string> = {}
              for (const attribute of Array.from(element.attributes)) {
                attributes[attribute.name] = attribute.value
              }

              return {
                id: element.id || `element_${index + 1}`,
                role: element.getAttribute("role") ?? element.tagName.toLowerCase(),
                name:
                  element.getAttribute("aria-label") ??
                  element.getAttribute("title") ??
                  ("value" in element ? String((element as HTMLInputElement).value || "") : null),
                text: element.innerText || element.textContent || null,
                selector: element.id ? `#${CSS.escape(element.id)}` : null,
                xpath: null,
                boundingBox: {
                  x: rect.x,
                  y: rect.y,
                  width: rect.width,
                  height: rect.height,
                },
                attributes,
              }
            }),
          }
        })

        return redactSensitiveData({
          ...snapshot,
          screenshotPath: state.lastScreenshotPath,
          metadata: {},
        })
      } catch (error) {
        if (attempt === OBSERVATION_CAPTURE_ATTEMPTS || !isNavigationContextError(error)) {
          throw error
        }
        await page.waitForLoadState("domcontentloaded")
      }
    }

    throw new Error("Observation capture exhausted without a result")
  }
```

Add this helper near the other module helpers:

```ts
function isNavigationContextError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return NAVIGATION_CONTEXT_ERROR_PATTERNS.some((pattern) => message.includes(pattern))
}
```

- [ ] **Step 5: Run browser tests**

Run:

```bash
OPEN_WEB_AGENT_BROWSER_HEADLESS=true bun test packages/browser/src/playwright-environment.test.ts
```

Expected: all browser tests pass, including retry success, retry exhaustion, non-navigation failure, and cancellation coverage.

- [ ] **Step 6: Commit the atomic observation change**

Run:

```bash
git add packages/browser/src/playwright-environment.ts packages/browser/src/playwright-environment.test.ts
git commit -m "[fix] retry observations across navigation"
```

---

### Task 2: Synchronize Navigation-Producing Browser Actions

**Files:**
- Modify: `packages/browser/src/playwright-environment.test.ts`
- Modify: `packages/browser/src/playwright-environment.ts`

- [ ] **Step 1: Extend the fixture with delayed navigation targets**

Replace `fixtureHtml()` and `startFixtureServer()` with:

```ts
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
```

- [ ] **Step 2: Add failing Enter, link, and coordinate navigation tests**

Add these tests after the existing DOM element-id click test:

```ts
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

  it("preserves viewport coordinates while using element click navigation waiting", async () => {
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
      fixture.stop()
      await env.close(ctx)
    }
  })

  it("does not install a raw-navigation watcher for focused key presses", async () => {
    const env = new PlaywrightEnvironment({ headless: true })
    const tools = new PlaywrightBrowserToolAdapter(env, { allowPrivateNetworkNavigation: true })
    const ctx = await context()
    const fixture = startFixtureServer()

    try {
      await env.reset(ctx)
      await tools.execute({ id: "tool_1", type: "navigate", url: fixture.url }, ctx)
      const page = env.pageForTools(ctx)
      await page.locator("#name").focus()
      const originalWaitForEvent = page.waitForEvent.bind(page)
      ;(page as unknown as { waitForEvent(): Promise<never> }).waitForEvent = async () => {
        throw new Error("raw navigation watcher should not be used")
      }

      try {
        const result = await tools.execute({ id: "tool_2", type: "press_key", key: "A" }, ctx)
        expect(result.ok).toBe(true)
        expect(result.observation?.text).toContain("Typed A")
      } finally {
        ;(page as unknown as { waitForEvent: typeof originalWaitForEvent }).waitForEvent = originalWaitForEvent
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
      const originalMouseClick = page.mouse.click.bind(page.mouse)
      ;(page as unknown as { evaluateHandle(): Promise<unknown> }).evaluateHandle = async () => ({
        asElement: () => null,
        async dispose() {},
      })
      ;(page.mouse as unknown as { click(): Promise<void> }).click = async () => {
        await page.goto(`${fixture.url}submitted`, { waitUntil: "commit" })
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
      } finally {
        ;(page as unknown as { evaluateHandle: typeof originalEvaluateHandle }).evaluateHandle = originalEvaluateHandle
        ;(page.mouse as unknown as { click: typeof originalMouseClick }).click = originalMouseClick
      }
    } finally {
      fixture.stop()
      await env.close(ctx)
    }
  })
```

- [ ] **Step 3: Run the navigation tests and confirm the Enter regression**

Run:

```bash
OPEN_WEB_AGENT_BROWSER_HEADLESS=true bun test packages/browser/src/playwright-environment.test.ts -t "navigation"
```

Expected: the Enter and coordinate tests return the original fixture observation instead of the delayed destination because the current raw input APIs resolve before navigation commits.

- [ ] **Step 4: Add navigation synchronization helpers**

Update the Playwright import:

```ts
import {
  chromium,
  errors,
  firefox,
  webkit,
  type Browser,
  type BrowserContext,
  type ElementHandle,
  type Page,
} from "playwright"
```

Add this module constant:

```ts
const RAW_INPUT_NAVIGATION_DETECTION_MS = 250
```

Add these helpers near `locatorForTarget()`:

```ts
async function focusedLocatorForKeyPress(page: Page) {
  const focused = page.locator(":focus")
  return (await focused.count()) > 0 ? focused.first() : page.locator("body")
}

async function elementAtCoordinates(
  page: Page,
  coordinates: { x: number; y: number },
): Promise<{ element: ElementHandle<Element>; position: { x: number; y: number } } | null> {
  const handle = await page.evaluateHandle(
    ({ x, y }) => document.elementFromPoint(x, y),
    coordinates,
  )
  const element = handle.asElement()
  if (!element) {
    await handle.dispose()
    return null
  }

  const box = await element.boundingBox()
  if (!box) {
    await element.dispose()
    return null
  }

  return {
    element,
    position: {
      x: coordinates.x - box.x,
      y: coordinates.y - box.y,
    },
  }
}

async function waitForMainFrameNavigation(page: Page): Promise<void> {
  try {
    await page.waitForEvent("framenavigated", {
      predicate: (frame) => frame === page.mainFrame(),
      timeout: RAW_INPUT_NAVIGATION_DETECTION_MS,
    })
    await page.waitForLoadState("domcontentloaded")
  } catch (error) {
    if (error instanceof errors.TimeoutError) return
    throw error
  }
}
```

- [ ] **Step 5: Replace coordinate click and key press execution**

Replace the coordinate branch of `click`:

```ts
      } else if (call.target.coordinates) {
        const target = await elementAtCoordinates(page, call.target.coordinates)
        if (target) {
          try {
            await this.withToolAbort(target.element.click({ position: target.position }), ctx)
          } finally {
            await target.element.dispose().catch(() => {})
          }
        } else {
          const navigation = waitForMainFrameNavigation(page)
          await this.withToolAbort(
            Promise.all([
              page.mouse.click(call.target.coordinates.x, call.target.coordinates.y),
              navigation,
            ]),
            ctx,
          )
        }
```

Replace the `press_key` action with:

```ts
    if (call.type === "press_key") {
      const locator = await focusedLocatorForKeyPress(page)
      await this.withToolAbort(locator.press(call.key), ctx)
      return {
        ok: true,
        message: "pressed key",
        observation: await this.environment.observe(ctx),
        metadata: { key: call.key },
      }
    }
```

- [ ] **Step 6: Run browser tests**

Run:

```bash
OPEN_WEB_AGENT_BROWSER_HEADLESS=true bun test packages/browser/src/playwright-environment.test.ts
```

Expected: all browser tests pass, and each navigation-producing action returns the destination observation.

- [ ] **Step 7: Commit action synchronization**

Run:

```bash
git add packages/browser/src/playwright-environment.ts packages/browser/src/playwright-environment.test.ts
git commit -m "[fix] await navigation-producing browser actions"
```

---

### Task 3: Reuse Per-Tool Observations in the Orchestrator

**Files:**
- Modify: `packages/core/src/orchestrator/run-orchestrator.test.ts`
- Modify: `packages/core/src/orchestrator/run-orchestrator.ts`

- [ ] **Step 1: Count environment observations in the test double**

Add a public counter to `TestEnvironment`:

```ts
  observeCalls = 0
```

Replace its `observe()` method with:

```ts
  async observe(): Promise<Observation> {
    this.observeCalls += 1
    return this.observation
  }
```

Add this adapter after `FailedResultBrowserToolAdapter`:

```ts
class NullObservationBrowserToolAdapter extends TestBrowserToolAdapter {
  async execute(call: BrowserToolCall, ctx: RuntimeContext): Promise<ActionResult> {
    this.calls.push(call)
    const result = await this.environment.applyBrowserTool(call, ctx)
    return { ...result, observation: null }
  }
}
```

- [ ] **Step 2: Add failing observation ownership tests**

Add these tests near the existing deterministic run test:

```ts
  it("reuses the final browser tool observation after an action batch", async () => {
    const environment = new TestEnvironment()
    const setup = await orchestratorWith(new TestAgent(), environment, new TestBrowserToolAdapter(environment))

    const result = await setup.orchestrator.startRun({
      session: session(),
      prompt: "reuse tool observation",
    }).result

    expect(result.status).toBe("completed")
    expect(environment.observeCalls).toBe(1)
    const captured = setup.observedEvents.filter((event) => event.type === "observation.captured")
    expect(captured).toHaveLength(2)
    expect(captured.at(-1)?.payload.observation).toMatchObject({
      url: "https://example.com/",
      title: "Example Domain",
    })
  })

  it("falls back to environment observation when tool results contain none", async () => {
    const environment = new TestEnvironment()
    const setup = await orchestratorWith(new TestAgent(), environment, new NullObservationBrowserToolAdapter(environment))

    const result = await setup.orchestrator.startRun({
      session: session(),
      prompt: "fallback observation",
    }).result

    expect(result.status).toBe("completed")
    expect(environment.observeCalls).toBe(2)
    const captured = setup.observedEvents.filter((event) => event.type === "observation.captured")
    expect(captured.at(-1)?.payload.observation).toMatchObject({
      url: "https://example.com/",
      title: "Example Domain",
    })
  })
```

- [ ] **Step 3: Run the tests and verify the duplicate read**

Run:

```bash
OPEN_WEB_AGENT_BROWSER_HEADLESS=true bun test packages/core/src/orchestrator/run-orchestrator.test.ts -t "observation"
```

Expected: the reuse test reports `observeCalls === 2` because the orchestrator always performs a post-action environment observation.

- [ ] **Step 4: Return the latest action-result observation**

Update the import in `run-orchestrator.ts`:

```ts
import type { ActionResult, BrowserToolCall, Observation } from "../contracts/browser"
```

Change the browser action call in `executeRun()` to:

```ts
        const actionObservation = await this.executeBrowserActions(
          decision,
          stepId,
          step.actionResults,
          ctx,
          environment,
        )
        state.lastObservation = actionObservation ?? (await environment.observe(ctx))
        step.observation = state.lastObservation
        await emit("observation.captured", { observation: state.lastObservation })
```

Change `executeBrowserActions()` to return `Promise<Observation | null>`, initialize a local observation, and update it for all tool and approval results:

```ts
  private async executeBrowserActions(
    decision: Extract<AgentDecision, { type: "browser_actions" }>,
    stepId: string,
    actionResults: ActionResult[],
    ctx: RuntimeContext,
    environment: BrowserEnvironment,
  ): Promise<Observation | null> {
    const toolAdapter = this.options.registry.getToolAdapterForEnvironment(
      ctx.environmentId ?? this.options.environmentId,
    )
    let latestObservation: Observation | null = null

    for (const action of decision.actions) {
      await ctx.emit("browser.action.started", { action }, stepId)
      let actionFailed = false

      throwIfAborted(ctx.abortSignal)
      if (action.requiresApproval) {
        await ctx.emit("human.approval.requested", { action }, stepId)
        const result: ActionResult = {
          ok: false,
          message: APPROVAL_REQUIRED_MESSAGE,
          observation: await observeSafely(environment, ctx),
          metadata: {
            approvalRequired: true,
            actionId: action.id,
          },
        }
        actionResults.push(result)
        if (result.observation) latestObservation = result.observation
        actionFailed = true
      } else {
        for (const toolCall of action.toolCalls) {
          throwIfAborted(ctx.abortSignal)
          await ctx.emit("browser.tool.started", { actionId: action.id, toolCall }, stepId)
          const result = await executeBrowserTool(toolAdapter, toolCall, ctx, environment)
          actionResults.push(result)
          if (result.observation) latestObservation = result.observation
          await ctx.emit("browser.tool.completed", { actionId: action.id, toolCall, result }, stepId)

          if (!result.ok) {
            actionFailed = true
            break
          }
        }
      }

      await ctx.emit("browser.action.completed", { action, actionResults }, stepId)
      if (actionFailed) break
    }

    return latestObservation
  }
```

- [ ] **Step 5: Run orchestrator tests**

Run:

```bash
OPEN_WEB_AGENT_BROWSER_HEADLESS=true bun test packages/core/src/orchestrator/run-orchestrator.test.ts
```

Expected: all orchestrator tests pass; the reuse path performs one initial environment observation and the fallback path performs two.

- [ ] **Step 6: Commit observation ownership**

Run:

```bash
git add packages/core/src/orchestrator/run-orchestrator.ts packages/core/src/orchestrator/run-orchestrator.test.ts
git commit -m "[refactor] reuse browser tool observations"
```

---

### Task 4: Verify the Complete Change

**Files:**
- Verify only; no expected source changes.

- [ ] **Step 1: Run focused browser tests**

Run:

```bash
OPEN_WEB_AGENT_BROWSER_HEADLESS=true bun test packages/browser/src/playwright-environment.test.ts
```

Expected: all tests pass with no destroyed execution-context errors.

- [ ] **Step 2: Run focused orchestrator tests**

Run:

```bash
OPEN_WEB_AGENT_BROWSER_HEADLESS=true bun test packages/core/src/orchestrator/run-orchestrator.test.ts
```

Expected: all tests pass, including observation reuse and fallback.

- [ ] **Step 3: Run strict TypeScript checking**

Run:

```bash
bun run typecheck
```

Expected: exit code 0 with no TypeScript errors.

- [ ] **Step 4: Run the complete source test suite**

Run:

```bash
OPEN_WEB_AGENT_BROWSER_HEADLESS=true bun run test
```

Expected: exit code 0 with all source tests passing.

- [ ] **Step 5: Inspect the final diff and worktree**

Run:

```bash
git diff HEAD~3 --check
git status --short
```

Expected: no whitespace errors; only the user's pre-existing `docs/code-review-2026-06-23.md` remains untracked.

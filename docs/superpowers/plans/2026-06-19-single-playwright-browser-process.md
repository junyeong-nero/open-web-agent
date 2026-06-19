# Single Playwright Browser Process Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep at most one real Playwright browser process open per runtime while preserving independent session browser state.

**Architecture:** `PlaywrightEnvironment` owns one shared Playwright `Browser` and stores only session-scoped `BrowserContext`/`Page` state in a map keyed by `session.id`. Existing `BrowserSessionManager` behavior remains session-oriented: opening, attaching, capturing, and closing sessions continue to flow through the environment contract, but the Playwright implementation reuses the shared process under those calls.

**Tech Stack:** Bun, TypeScript, Playwright, `bun:test`, existing `@open-web-agent/*` workspace packages.

---

## File Structure

- Modify: `packages/browser/src/playwright-environment.ts`
  - Replace the per-session `Browser` state map with one shared `Browser`.
  - Keep session-specific `BrowserContext`, `Page`, screenshot path, and screenshot count in a session map.
  - Add a guarded shared launch promise so concurrent opens do not launch duplicate browser processes.
  - Close only a session context for `close(ctx)` and close the shared browser when the last session is closed.

- Modify: `packages/browser/src/playwright-environment.test.ts`
  - Add fake Playwright browser/context/page test helpers.
  - Prove that multiple sessions share one browser launch while retaining separate contexts/pages.
  - Prove same-session reattach reuses the existing page.
  - Prove closing one session leaves the shared browser alive while another session remains.
  - Update the focus-prevention test to work against the new shared browser fields.

- Modify: `packages/server/src/app.test.ts`
  - Rename the route test that currently says "bound one-to-one with the session" so it does not imply one process per session.
  - Keep the existing route behavior intact.

---

### Task 1: Add Playwright Environment Tests

**Files:**
- Modify: `packages/browser/src/playwright-environment.test.ts`

- [ ] **Step 1: Update the test context helper to accept session and run ids**

Replace the existing `context()` helper at the top of `packages/browser/src/playwright-environment.test.ts` with:

```ts
async function context(sessionId = "ses_1", runId = "run_1"): Promise<RuntimeContext> {
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
    abortSignal: new AbortController().signal,
    now: () => new Date("2026-06-17T00:00:00.000Z"),
    async emit() {
      throw new Error("not used")
    },
  }
}
```

- [ ] **Step 2: Add fake Playwright helpers below `fixtureUrl()`**

Add this helper code after the existing `fixtureUrl()` function:

```ts
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
  let launchCalls = 0
  ;(env as unknown as { launchBrowser(): Promise<unknown> }).launchBrowser = async () => {
    launchCalls += 1
    return await browser
  }
  return { launchCalls: () => launchCalls }
}
```

- [ ] **Step 3: Replace the focus-prevention test body**

Replace the existing `it("does not bring an existing page to the front when browser focus prevention is enabled", ...)` body with:

```ts
  it("does not bring an existing page to the front when browser focus prevention is enabled", async () => {
    const env = new PlaywrightEnvironment({ preventFocus: true })
    const fake = createFakeBrowser()
    stubBrowserLaunch(env, fake.browser)
    const ctx = await context()

    await env.attachSession(ctx)

    expect(fake.contexts[0]?.pages[0]?.bringToFrontCalls).toBe(0)
  })
```

- [ ] **Step 4: Add shared-process tests after the focus-prevention test**

Add these tests inside the existing `describe("PlaywrightEnvironment", () => { ... })` block, after the focus-prevention test:

```ts
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
```

- [ ] **Step 5: Run the new tests and verify they fail for the expected reason**

Run:

```bash
bun test packages/browser/src/playwright-environment.test.ts
```

Expected result: the shared-process tests fail because the implementation still launches a separate `browser` for each session and does not coalesce concurrent opens through a shared launch promise.

- [ ] **Step 6: Commit the failing tests**

Run:

```bash
git add packages/browser/src/playwright-environment.test.ts
git commit -m "[test] capture shared playwright browser process contract"
```

---

### Task 2: Implement Shared Playwright Browser State

**Files:**
- Modify: `packages/browser/src/playwright-environment.ts`

- [ ] **Step 1: Replace the run state interface**

Replace:

```ts
interface PlaywrightRunState {
  browser: Browser
  context: BrowserContext
  page: Page
  lastScreenshotPath: string | null
  screenshotCount: number
}
```

With:

```ts
interface PlaywrightSessionState {
  context: BrowserContext
  page: Page
  lastScreenshotPath: string | null
  screenshotCount: number
}
```

- [ ] **Step 2: Replace the class fields**

Replace:

```ts
  private runs = new Map<string, PlaywrightRunState>()
```

With:

```ts
  private browser: Browser | null = null
  private openingBrowser: Promise<Browser> | null = null
  private sessions = new Map<string, PlaywrightSessionState>()
```

- [ ] **Step 3: Replace `ensureState(ctx)`**

Replace the full `ensureState(ctx)` method with:

```ts
  private async ensureState(ctx: RuntimeContext): Promise<PlaywrightSessionState> {
    const key = this.keyFor(ctx)
    const existing = this.sessions.get(key)
    if (existing && this.browser?.isConnected()) return existing

    const browser = await this.ensureBrowser(ctx)
    const context = await browser.newContext()
    try {
      const page = await context.newPage()
      const state = {
        context,
        page,
        lastScreenshotPath: null,
        screenshotCount: 0,
      }
      this.sessions.set(key, state)
      return state
    } catch (error) {
      await context.close().catch(() => {})
      throw error
    }
  }
```

- [ ] **Step 4: Add `ensureBrowser(ctx)` below `ensureState(ctx)`**

Add this method immediately after `ensureState(ctx)`:

```ts
  private async ensureBrowser(ctx: RuntimeContext): Promise<Browser> {
    if (this.browser?.isConnected()) return this.browser

    if (this.browser && !this.browser.isConnected()) {
      await this.discardSessionStates()
      this.browser = null
    }

    if (!this.openingBrowser) {
      this.openingBrowser = this.launchBrowser()
        .then((browser) => {
          this.browser = browser
          return browser
        })
        .finally(() => {
          this.openingBrowser = null
        })
    }

    return withAbort(this.openingBrowser, ctx.abortSignal)
  }
```

- [ ] **Step 5: Add `discardSessionStates()` below `ensureBrowser(ctx)`**

Add this method immediately after `ensureBrowser(ctx)`:

```ts
  private async discardSessionStates(): Promise<void> {
    const states = [...this.sessions.values()]
    this.sessions.clear()
    await Promise.all(states.map((state) => state.context.close().catch(() => {})))
  }
```

- [ ] **Step 6: Replace `close(ctx)`**

Replace the full `close(ctx)` method with:

```ts
  async close(ctx: RuntimeContext): Promise<void> {
    const key = this.keyFor(ctx)
    const state = this.sessions.get(key)
    if (!state) return

    this.sessions.delete(key)
    await state.context.close().catch(() => {})

    if (this.sessions.size === 0 && this.browser) {
      const browser = this.browser
      this.browser = null
      await browser.close().catch(() => {})
    }
  }
```

- [ ] **Step 7: Replace `requireState(ctx)`**

Replace the full `requireState(ctx)` method with:

```ts
  private requireState(ctx: RuntimeContext): PlaywrightSessionState {
    const state = this.sessions.get(this.keyFor(ctx))
    if (!state || !this.browser?.isConnected()) {
      throw new Error("PlaywrightEnvironment has not been opened for the session")
    }
    return state
  }
```

- [ ] **Step 8: Update remaining `runs` references**

Search:

```bash
rg -n "runs|PlaywrightRunState" packages/browser/src/playwright-environment.ts packages/browser/src/playwright-environment.test.ts
```

Expected: no matches. If there are matches, replace implementation references with `sessions` and remove test references to the old private field.

- [ ] **Step 9: Run the focused Playwright environment tests**

Run:

```bash
bun test packages/browser/src/playwright-environment.test.ts
```

Expected: all tests in `packages/browser/src/playwright-environment.test.ts` pass.

- [ ] **Step 10: Commit the implementation**

Run:

```bash
git add packages/browser/src/playwright-environment.ts
git commit -m "[fix] reuse one playwright browser process across sessions"
```

---

### Task 3: Refresh Server Test Wording

**Files:**
- Modify: `packages/server/src/app.test.ts`

- [ ] **Step 1: Rename the session creation lifecycle test**

Replace the test name:

```ts
  it("POST /sessions opens a browser page bound one-to-one with the session", async () => {
```

With:

```ts
  it("POST /sessions opens a session-bound browser page", async () => {
```

- [ ] **Step 2: Run the server app tests**

Run:

```bash
bun test packages/server/src/app.test.ts
```

Expected: all tests in `packages/server/src/app.test.ts` pass.

- [ ] **Step 3: Commit the test wording update**

Run:

```bash
git add packages/server/src/app.test.ts
git commit -m "[test] clarify session browser lifecycle wording"
```

---

### Task 4: Full Verification

**Files:**
- No code changes expected.

- [ ] **Step 1: Run typecheck**

Run:

```bash
bun run typecheck
```

Expected: `tsc -b` exits with status 0.

- [ ] **Step 2: Run all tests**

Run:

```bash
bun test
```

Expected: all tests pass. The current baseline before implementation was 266 passing tests; the final count should be higher after adding new Playwright environment tests.

- [ ] **Step 3: Inspect final diff**

Run:

```bash
git status --short
git diff --check
git log --oneline -5
```

Expected:

- `git status --short` shows no uncommitted files if every task was committed.
- `git diff --check` prints no whitespace errors.
- The recent history includes the design commit, test commit, implementation commit, and test wording commit.

---

## Self-Review

Spec coverage:

- One browser process per runtime: covered by Task 1 shared launch test and Task 2 shared `browser` field.
- Concurrent opens do not launch duplicate processes: covered by Task 1 concurrent session open test and Task 2 `openingBrowser` promise.
- Session-specific state: covered by Task 1 separate context/page assertions and Task 2 `sessions` map.
- Session switching attach behavior: covered by Task 1 reattach test and unchanged `attachSession(ctx)` behavior.
- Closing one session only closes that session state: covered by Task 1 close sequencing test and Task 2 `close(ctx)`.
- Runtime shutdown closes the process: covered through final-session close behavior, which is what `BrowserSessionManager.closeAll()` reaches during runtime stop.
- Focus prevention: covered by Task 1 updated focus-prevention test.
- Mock browser unchanged: covered by leaving `packages/browser/src/mock-environment.ts` untouched and full test verification.

Red-flag scan:

- No TBD/TODO-style placeholders remain; unchecked boxes are retained as the plan's execution template.

Type consistency:

- `PlaywrightSessionState`, `browser`, `openingBrowser`, and `sessions` are introduced before later steps use them.
- The implementation continues to use the existing `BrowserEnvironment` contract and existing `RuntimeContext`.

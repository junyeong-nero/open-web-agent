import { existsSync, readdirSync } from "node:fs"
import { mkdir } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
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
import {
  isAllowedBrowserNavigationUrl,
  REDACTED_VALUE,
  redactSensitiveData,
  type ActionResult,
  type BrowserEnvironment,
  type BrowserToolCall,
  type BrowserToolDefinition,
  type Observation,
  type RuntimeContext,
  type ToolAdapter,
} from "@open-web-agent/core"

export interface PlaywrightEnvironmentOptions {
  browserName?: "chromium" | "firefox" | "webkit"
  headless?: boolean
  preventFocus?: boolean
}

export interface PlaywrightBrowserToolAdapterOptions {
  allowPrivateNetworkNavigation?: boolean
}

interface PlaywrightSessionState {
  context: BrowserContext
  page: Page
  lastScreenshotPath: string | null
  screenshotCount: number
}

const OBSERVATION_CAPTURE_ATTEMPTS = 3
const NAVIGATION_CONTEXT_ERROR_PATTERNS = [
  "Execution context was destroyed",
  "Cannot find context with specified id",
]
const RAW_INPUT_NAVIGATION_DETECTION_MS = 250

export class PlaywrightEnvironment implements BrowserEnvironment {
  id = "playwright-browser"
  name = "Playwright Browser"
  private browser: Browser | null = null
  private openingBrowser: Promise<Browser> | null = null
  private sessions = new Map<string, PlaywrightSessionState>()
  private openingSessions = new Map<string, Promise<PlaywrightSessionState>>()

  constructor(private readonly options: PlaywrightEnvironmentOptions = {}) {}

  setHeadless(headless: boolean): void {
    this.options.headless = headless
  }

  async openSession(ctx: RuntimeContext): Promise<void> {
    await this.ensureState(ctx)
  }

  async attachSession(ctx: RuntimeContext): Promise<void> {
    const state = await this.ensureState(ctx)
    if (!this.options.preventFocus) {
      await state.page.bringToFront().catch(() => {})
    }
  }

  async reset(ctx: RuntimeContext): Promise<void> {
    await this.attachSession(ctx)
  }

  private async ensureState(ctx: RuntimeContext): Promise<PlaywrightSessionState> {
    const key = this.keyFor(ctx)
    const existing = this.sessions.get(key)
    if (existing && this.browser?.isConnected()) return existing

    const opening = this.openingSessions.get(key)
    if (opening) return withAbort(opening, ctx.abortSignal)

    const openingSession = this.openSessionState(key)
    this.openingSessions.set(key, openingSession)
    return withAbort(openingSession, ctx.abortSignal)
  }

  private async openSessionState(key: string): Promise<PlaywrightSessionState> {
    const browser = await this.ensureBrowser()
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
    } finally {
      this.openingSessions.delete(key)
    }
  }

  private async ensureBrowser(): Promise<Browser> {
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

    return this.openingBrowser
  }

  private async discardSessionStates(): Promise<void> {
    const states = [...this.sessions.values()]
    this.sessions.clear()
    await Promise.all(states.map((state) => state.context.close().catch(() => {})))
  }

  async observe(ctx: RuntimeContext): Promise<Observation> {
    const state = this.requireState(ctx)
    return withAbort(this.readObservation(state), ctx.abortSignal, () => this.close(ctx))
  }

  pageForTools(ctx: RuntimeContext): Page {
    return this.requireState(ctx).page
  }

  nextScreenshotPath(ctx: RuntimeContext): string {
    const state = this.requireState(ctx)
    state.screenshotCount += 1
    return join(ctx.runDir, "screenshots", `step-${String(state.screenshotCount).padStart(4, "0")}.png`)
  }

  recordScreenshotPath(ctx: RuntimeContext, screenshotPath: string): void {
    this.requireState(ctx).lastScreenshotPath = screenshotPath
  }

  async close(ctx: RuntimeContext): Promise<void> {
    const key = this.keyFor(ctx)
    const state = this.sessions.get(key) ?? (await this.openingSessions.get(key)?.catch(() => null))
    if (!state) return

    this.sessions.delete(key)
    await state.context.close().catch(() => {})
    await this.closeBrowserIfIdle()
  }

  private async closeBrowserIfIdle(): Promise<void> {
    if (this.sessions.size === 0 && this.openingSessions.size === 0 && this.browser) {
      const browser = this.browser
      this.browser = null
      await browser.close().catch(() => {})
    }
  }

  private async launchBrowser(): Promise<Browser> {
    const headless = resolvePlaywrightHeadless(this.options)
    if (this.options.browserName === "firefox") return firefox.launch({ headless })
    if (this.options.browserName === "webkit") return webkit.launch({ headless })
    const launchOptions = resolveChromiumLaunchOptions(this.options)
    try {
      return await chromium.launch(launchOptions)
    } catch (error) {
      const executablePath = findCachedChromiumExecutable()
      if (executablePath) return chromium.launch({ ...launchOptions, executablePath })
      throw error
    }
  }

  private requireState(ctx: RuntimeContext): PlaywrightSessionState {
    const state = this.sessions.get(this.keyFor(ctx))
    if (!state || !this.browser?.isConnected()) {
      throw new Error("PlaywrightEnvironment has not been opened for the session")
    }
    return state
  }

  private keyFor(ctx: RuntimeContext): string {
    return ctx.session.id
  }

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
}

export class PlaywrightBrowserToolAdapter implements ToolAdapter {
  id = "playwright-browser-tools"
  name = "Playwright Browser Tools"
  environmentId = "playwright-browser"

  constructor(
    private readonly environment: PlaywrightEnvironment,
    private readonly options: PlaywrightBrowserToolAdapterOptions = {},
  ) {}

  listTools(): BrowserToolDefinition[] {
    return [...PLAYWRIGHT_BROWSER_TOOL_DEFINITIONS]
  }

  async execute(call: BrowserToolCall, ctx: RuntimeContext): Promise<ActionResult> {
    if (call.type === "navigate") {
      if (!isAllowedBrowserNavigationUrl(call.url, this.options)) {
        return {
          ok: false,
          message: "Blocked unsafe navigation URL",
          observation: await this.observeIfAvailable(ctx),
          metadata: { url: call.url },
        }
      }

      const page = this.environment.pageForTools(ctx)
      await this.withToolAbort(page.goto(call.url, { waitUntil: "domcontentloaded" }), ctx)
      return { ok: true, message: "navigated", observation: await this.environment.observe(ctx), metadata: { url: call.url } }
    }

    const page = this.environment.pageForTools(ctx)

    if (call.type === "click") {
      const locator = locatorForTarget(page, call.target)
      if (locator) {
        await this.withToolAbort(locator.click(), ctx)
        await this.withToolAbort(page.waitForLoadState("domcontentloaded"), ctx)
      } else if (call.target.coordinates) {
        const target = await elementAtCoordinates(page, call.target.coordinates)
        if (target) {
          try {
            await this.withToolAbort(target.element.click({ position: target.position }), ctx)
            await this.withToolAbort(page.waitForLoadState("domcontentloaded"), ctx)
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
      } else {
        return {
          ok: false,
          message: "No click target provided",
          observation: await this.environment.observe(ctx),
          metadata: {},
        }
      }
      return { ok: true, message: "clicked", observation: await this.environment.observe(ctx), metadata: {} }
    }

    if (call.type === "type") {
      const locator = locatorForTarget(page, call.target)
      if (!locator) {
        return {
          ok: false,
          message: "No type target provided",
          observation: await this.environment.observe(ctx),
          metadata: {},
        }
      }
      await this.withToolAbort(locator.fill(call.value), ctx)
      return { ok: true, message: "typed", observation: await this.environment.observe(ctx), metadata: { value: REDACTED_VALUE } }
    }

    if (call.type === "scroll") {
      await this.withToolAbort(page.mouse.wheel(call.deltaX, call.deltaY), ctx)
      return {
        ok: true,
        message: "scrolled",
        observation: await this.environment.observe(ctx),
        metadata: { deltaX: call.deltaX, deltaY: call.deltaY },
      }
    }

    if (call.type === "wait") {
      await this.withToolAbort(page.waitForTimeout(call.ms), ctx)
      return { ok: true, message: "waited", observation: await this.environment.observe(ctx), metadata: { ms: call.ms } }
    }

    if (call.type === "press_key") {
      const locator = await focusedLocatorForKeyPress(page)
      await this.withToolAbort(locator.press(call.key), ctx)
      await this.withToolAbort(page.waitForLoadState("domcontentloaded"), ctx)
      return {
        ok: true,
        message: "pressed key",
        observation: await this.environment.observe(ctx),
        metadata: { key: call.key },
      }
    }

    if (call.type === "screenshot") {
      const screenshotPath = this.environment.nextScreenshotPath(ctx)
      await mkdir(join(ctx.runDir, "screenshots"), { recursive: true })
      await this.withToolAbort(page.screenshot({ path: screenshotPath, fullPage: true }), ctx)
      this.environment.recordScreenshotPath(ctx, screenshotPath)
      return {
        ok: true,
        message: "screenshot captured",
        observation: await this.environment.observe(ctx),
        metadata: { screenshotPath },
      }
    }

    if (call.type === "extract_text") {
      const observation = await this.environment.observe(ctx)
      return { ok: true, message: "text extracted", observation, metadata: { text: observation.text } }
    }

    if (call.type === "go_back") {
      await this.withToolAbort(page.goBack({ waitUntil: "domcontentloaded" }), ctx)
      return { ok: true, message: "went back", observation: await this.environment.observe(ctx), metadata: {} }
    }

    if (call.type === "go_forward") {
      await this.withToolAbort(page.goForward({ waitUntil: "domcontentloaded" }), ctx)
      return { ok: true, message: "went forward", observation: await this.environment.observe(ctx), metadata: {} }
    }

    return {
      ok: false,
      message: `Unsupported Playwright tool: ${(call as BrowserToolCall).type}`,
      observation: await this.environment.observe(ctx),
      metadata: {},
    }
  }

  private async observeIfAvailable(ctx: RuntimeContext): Promise<Observation | null> {
    return this.environment.observe(ctx).catch(() => null)
  }

  private withToolAbort<T>(promise: Promise<T>, ctx: RuntimeContext): Promise<T> {
    return withAbort(promise, ctx.abortSignal, () => this.environment.close(ctx))
  }
}

const PLAYWRIGHT_BROWSER_TOOL_DEFINITIONS: BrowserToolDefinition[] = [
  {
    type: "navigate",
    description: "Open an absolute URL in the current browser page.",
    parameters: [{ name: "url", type: "string", required: true, description: "Absolute URL to open." }],
    example: { id: "tool_1", type: "navigate", url: "https://example.com" },
  },
  {
    type: "click",
    description: "Click an interactive element or coordinate on the current page.",
    parameters: [
      { name: "target", type: "ActionTarget", required: true, description: "Element or coordinates to click." },
    ],
    example: { id: "tool_2", type: "click", target: { selector: 'button[type="submit"]' } },
  },
  {
    type: "type",
    description: "Fill text into an editable element on the current page.",
    parameters: [
      { name: "target", type: "ActionTarget", required: true, description: "Editable element to fill." },
      { name: "value", type: "string", required: true, description: "Text to enter." },
    ],
    example: { id: "tool_3", type: "type", target: { selector: 'input[name="query"]' }, value: "tomorrow weather" },
  },
  {
    type: "scroll",
    description: "Scroll the current page by pixel deltas.",
    parameters: [
      { name: "deltaX", type: "number", required: false, description: "Horizontal scroll delta in pixels." },
      { name: "deltaY", type: "number", required: true, description: "Vertical scroll delta in pixels." },
    ],
    example: { id: "tool_4", type: "scroll", deltaX: 0, deltaY: 700 },
  },
  {
    type: "wait",
    description: "Wait for a fixed number of milliseconds.",
    parameters: [{ name: "ms", type: "positive integer", required: true, description: "Milliseconds to wait." }],
    example: { id: "tool_5", type: "wait", ms: 1000 },
  },
  {
    type: "press_key",
    description: "Press a keyboard key in the current page.",
    parameters: [{ name: "key", type: "string", required: true, description: "Playwright key name to press." }],
    example: { id: "tool_6", type: "press_key", key: "Enter" },
  },
  {
    type: "screenshot",
    description: "Capture a full-page screenshot for visual inspection.",
    parameters: [],
    example: { id: "tool_7", type: "screenshot" },
  },
  {
    type: "extract_text",
    description: "Extract visible page text from the current browser observation.",
    parameters: [],
    example: { id: "tool_8", type: "extract_text" },
  },
  {
    type: "go_back",
    description: "Navigate back in browser history.",
    parameters: [],
    example: { id: "tool_9", type: "go_back" },
  },
  {
    type: "go_forward",
    description: "Navigate forward in browser history.",
    parameters: [],
    example: { id: "tool_10", type: "go_forward" },
  },
]

export function resolvePlaywrightHeadless(options: Pick<PlaywrightEnvironmentOptions, "headless">): boolean {
  return options.headless ?? false
}

export function resolveChromiumLaunchOptions(
  options: Pick<PlaywrightEnvironmentOptions, "headless" | "preventFocus">,
): { headless: boolean; args?: string[] } {
  const headless = resolvePlaywrightHeadless(options)
  return {
    headless,
    ...(!headless && options.preventFocus ? { args: ["--start-minimized"] } : {}),
  }
}

function locatorForTarget(page: Page, target: {
  elementId: string | null
  selector: string | null
  text: string | null
  role: string | null
  name: string | null
}) {
  if (target.selector) return page.locator(target.selector).first()
  if (target.elementId && !isGeneratedElementId(target.elementId)) {
    return page.locator(`[id="${escapeCssString(target.elementId)}"]`).first()
  }
  if (target.role) return page.getByRole(target.role as Parameters<Page["getByRole"]>[0], { name: target.name ?? undefined }).first()
  if (target.text) return page.getByText(target.text).first()
  return null
}

async function focusedLocatorForKeyPress(page: Page) {
  const focused = page.locator(":focus")
  return (await focused.count()) > 0 ? focused.first() : page.locator("body")
}

async function elementAtCoordinates(
  page: Page,
  coordinates: { x: number; y: number },
): Promise<{ element: ElementHandle<HTMLElement>; position: { x: number; y: number } } | null> {
  const handle = await page.evaluateHandle(({ x, y }) => document.elementFromPoint(x, y), coordinates)
  const element = handle.asElement() as ElementHandle<HTMLElement> | null
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

function isGeneratedElementId(elementId: string): boolean {
  return /^element_\d+$/.test(elementId)
}

function escapeCssString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
}

function isNavigationContextError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return NAVIGATION_CONTEXT_ERROR_PATTERNS.some((pattern) => message.includes(pattern))
}

function withAbort<T>(promise: Promise<T>, signal: AbortSignal, onAbort?: () => Promise<void> | void): Promise<T> {
  if (signal.aborted) {
    return runAbortCleanup(onAbort).then(() => Promise.reject(abortErrorFromSignal(signal)))
  }

  return new Promise<T>((resolve, reject) => {
    let settled = false
    const settleResolve = (value: T) => {
      if (settled) return
      settled = true
      signal.removeEventListener("abort", onSignalAbort)
      resolve(value)
    }
    const settleReject = (error: unknown) => {
      if (settled) return
      settled = true
      signal.removeEventListener("abort", onSignalAbort)
      reject(error)
    }
    const onSignalAbort = () => {
      if (settled) return
      settled = true
      signal.removeEventListener("abort", onSignalAbort)
      const error = abortErrorFromSignal(signal)
      runAbortCleanup(onAbort).then(() => reject(error))
    }

    signal.addEventListener("abort", onSignalAbort, { once: true })
    promise.then(
      (value) => settleResolve(value),
      (error) => settleReject(error),
    )
  })
}

async function runAbortCleanup(onAbort: (() => Promise<void> | void) | undefined): Promise<void> {
  try {
    await onAbort?.()
  } catch {
  }
}

function abortErrorFromSignal(signal: AbortSignal): unknown {
  if (signal.reason instanceof Error && signal.reason.name !== "AbortError") return signal.reason
  return new DOMException("Run cancelled", "AbortError")
}

function findCachedChromiumExecutable(): string | null {
  const cacheRoot = process.env.PLAYWRIGHT_BROWSERS_PATH || join(homedir(), "Library", "Caches", "ms-playwright")
  if (!existsSync(cacheRoot)) return null

  for (const entry of readdirSync(cacheRoot)) {
    if (!entry.startsWith("chromium-")) continue

    const root = join(cacheRoot, entry)
    const candidates = [
      join(root, "chrome-mac-arm64", "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing"),
      join(root, "chrome-mac", "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing"),
      join(root, "chrome-linux", "chrome"),
      join(root, "chrome-win", "chrome.exe"),
    ]

    const executable = candidates.find((candidate) => existsSync(candidate))
    if (executable) return executable
  }

  return null
}

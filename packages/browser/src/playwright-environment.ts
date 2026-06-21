import { existsSync, readdirSync } from "node:fs"
import { mkdir } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { chromium, firefox, webkit, type Browser, type BrowserContext, type Page } from "playwright"
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

export class PlaywrightEnvironment implements BrowserEnvironment {
  id = "playwright-browser"
  name = "Playwright Browser"
  private browser: Browser | null = null
  private openingBrowser: Promise<Browser> | null = null
  private sessions = new Map<string, PlaywrightSessionState>()
  private openingSessions = new Map<string, Promise<PlaywrightSessionState>>()

  constructor(private readonly options: PlaywrightEnvironmentOptions = {}) {}

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
    return withAbort(this.readObservation(state), ctx.abortSignal)
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
    const [title, text, interactiveElements] = await Promise.all([
      page.title().catch(() => null),
      page.locator("body").innerText().catch(() => null),
      page.evaluate(() => {
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

        return candidates.map(({ element, rect }, index) => {
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
        })
      }),
    ])

    return redactSensitiveData({
      url: page.url(),
      title,
      text,
      screenshotPath: state.lastScreenshotPath,
      interactiveElements,
      metadata: {},
    })
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
      await withAbort(page.goto(call.url, { waitUntil: "domcontentloaded" }), ctx.abortSignal)
      return { ok: true, message: "navigated", observation: await this.environment.observe(ctx), metadata: { url: call.url } }
    }

    const page = this.environment.pageForTools(ctx)

    if (call.type === "click") {
      const locator = locatorForTarget(page, call.target)
      if (locator) {
        await withAbort(locator.click(), ctx.abortSignal)
      } else if (call.target.coordinates) {
        await withAbort(page.mouse.click(call.target.coordinates.x, call.target.coordinates.y), ctx.abortSignal)
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
      await withAbort(locator.fill(call.value), ctx.abortSignal)
      return { ok: true, message: "typed", observation: await this.environment.observe(ctx), metadata: { value: REDACTED_VALUE } }
    }

    if (call.type === "scroll") {
      await withAbort(page.mouse.wheel(call.deltaX, call.deltaY), ctx.abortSignal)
      return {
        ok: true,
        message: "scrolled",
        observation: await this.environment.observe(ctx),
        metadata: { deltaX: call.deltaX, deltaY: call.deltaY },
      }
    }

    if (call.type === "wait") {
      await withAbort(page.waitForTimeout(call.ms), ctx.abortSignal)
      return { ok: true, message: "waited", observation: await this.environment.observe(ctx), metadata: { ms: call.ms } }
    }

    if (call.type === "press_key") {
      await withAbort(page.keyboard.press(call.key), ctx.abortSignal)
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
      await withAbort(page.screenshot({ path: screenshotPath, fullPage: true }), ctx.abortSignal)
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
      await withAbort(page.goBack({ waitUntil: "domcontentloaded" }), ctx.abortSignal)
      return { ok: true, message: "went back", observation: await this.environment.observe(ctx), metadata: {} }
    }

    if (call.type === "go_forward") {
      await withAbort(page.goForward({ waitUntil: "domcontentloaded" }), ctx.abortSignal)
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
  selector: string | null
  text: string | null
  role: string | null
  name: string | null
}) {
  if (target.selector) return page.locator(target.selector).first()
  if (target.role) return page.getByRole(target.role as Parameters<Page["getByRole"]>[0], { name: target.name ?? undefined }).first()
  if (target.text) return page.getByText(target.text).first()
  return null
}

function withAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new DOMException("Run cancelled", "AbortError"))

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new DOMException("Run cancelled", "AbortError"))
    signal.addEventListener("abort", onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort)
        resolve(value)
      },
      (error) => {
        signal.removeEventListener("abort", onAbort)
        reject(error)
      },
    )
  })
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

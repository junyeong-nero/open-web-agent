import { existsSync, readdirSync } from "node:fs"
import { mkdir } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { chromium, firefox, webkit, type Browser, type BrowserContext, type Page } from "playwright"
import type {
  ActionResult,
  BrowserEnvironment,
  BrowserToolCall,
  Observation,
  RuntimeContext,
  ToolAdapter,
} from "@open-web-agent/core"

export interface PlaywrightEnvironmentOptions {
  browserName?: "chromium" | "firefox" | "webkit"
  headless?: boolean
  preventFocus?: boolean
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

    return {
      url: page.url(),
      title,
      text,
      screenshotPath: state.lastScreenshotPath,
      interactiveElements,
      metadata: {},
    }
  }
}

export class PlaywrightBrowserToolAdapter implements ToolAdapter {
  id = "playwright-browser-tools"
  name = "Playwright Browser Tools"
  environmentId = "playwright-browser"

  constructor(private readonly environment: PlaywrightEnvironment) {}

  async execute(call: BrowserToolCall, ctx: RuntimeContext): Promise<ActionResult> {
    const page = this.environment.pageForTools(ctx)

    if (call.type === "navigate") {
      await withAbort(page.goto(call.url, { waitUntil: "domcontentloaded" }), ctx.abortSignal)
      return { ok: true, message: "navigated", observation: await this.environment.observe(ctx), metadata: { url: call.url } }
    }

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
      return { ok: true, message: "typed", observation: await this.environment.observe(ctx), metadata: { value: call.value } }
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
}

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

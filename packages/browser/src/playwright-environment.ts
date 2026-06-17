import { existsSync, readdirSync } from "node:fs"
import { mkdir } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { chromium, firefox, webkit, type Browser, type BrowserContext, type Page } from "playwright"
import type { ActionResult, BrowserEnvironment, BrowserToolCall, Observation, RuntimeContext } from "@open-web-agent/core"

export interface PlaywrightEnvironmentOptions {
  browserName?: "chromium" | "firefox" | "webkit"
  headless?: boolean
}

export class PlaywrightEnvironment implements BrowserEnvironment {
  id = "playwright-browser"
  name = "Playwright Browser"
  private browser: Browser | null = null
  private context: BrowserContext | null = null
  private page: Page | null = null
  private lastScreenshotPath: string | null = null
  private screenshotCount = 0

  constructor(private readonly options: PlaywrightEnvironmentOptions = {}) {}

  async reset(ctx: RuntimeContext): Promise<void> {
    await this.close(ctx)
    this.browser = await withAbort(this.launchBrowser(), ctx.abortSignal)
    this.context = await this.browser.newContext()
    this.page = await this.context.newPage()
    this.lastScreenshotPath = null
    this.screenshotCount = 0
  }

  async observe(ctx: RuntimeContext): Promise<Observation> {
    const page = this.requirePage()
    return withAbort(this.readObservation(page), ctx.abortSignal)
  }

  async execute(call: BrowserToolCall, ctx: RuntimeContext): Promise<ActionResult> {
    const page = this.requirePage()

    if (call.type === "navigate") {
      await withAbort(page.goto(call.url, { waitUntil: "domcontentloaded" }), ctx.abortSignal)
      return { ok: true, message: "navigated", observation: await this.observe(ctx), metadata: { url: call.url } }
    }

    if (call.type === "click") {
      const locator = this.locatorForTarget(page, call.target)
      if (locator) {
        await withAbort(locator.click(), ctx.abortSignal)
      } else if (call.target.coordinates) {
        await withAbort(page.mouse.click(call.target.coordinates.x, call.target.coordinates.y), ctx.abortSignal)
      } else {
        return { ok: false, message: "No click target provided", observation: await this.observe(ctx), metadata: {} }
      }
      return { ok: true, message: "clicked", observation: await this.observe(ctx), metadata: {} }
    }

    if (call.type === "type") {
      const locator = this.locatorForTarget(page, call.target)
      if (!locator) return { ok: false, message: "No type target provided", observation: await this.observe(ctx), metadata: {} }
      await withAbort(locator.fill(call.value), ctx.abortSignal)
      return { ok: true, message: "typed", observation: await this.observe(ctx), metadata: { value: call.value } }
    }

    if (call.type === "scroll") {
      await withAbort(page.mouse.wheel(call.deltaX, call.deltaY), ctx.abortSignal)
      return { ok: true, message: "scrolled", observation: await this.observe(ctx), metadata: { deltaX: call.deltaX, deltaY: call.deltaY } }
    }

    if (call.type === "wait") {
      await withAbort(page.waitForTimeout(call.ms), ctx.abortSignal)
      return { ok: true, message: "waited", observation: await this.observe(ctx), metadata: { ms: call.ms } }
    }

    if (call.type === "press_key") {
      await withAbort(page.keyboard.press(call.key), ctx.abortSignal)
      return { ok: true, message: "pressed key", observation: await this.observe(ctx), metadata: { key: call.key } }
    }

    if (call.type === "screenshot") {
      this.screenshotCount += 1
      const screenshotPath = join(ctx.runDir, "screenshots", `step-${String(this.screenshotCount).padStart(4, "0")}.png`)
      await mkdir(join(ctx.runDir, "screenshots"), { recursive: true })
      await withAbort(page.screenshot({ path: screenshotPath, fullPage: true }), ctx.abortSignal)
      this.lastScreenshotPath = screenshotPath
      return { ok: true, message: "screenshot captured", observation: await this.observe(ctx), metadata: { screenshotPath } }
    }

    if (call.type === "extract_text") {
      const observation = await this.observe(ctx)
      return { ok: true, message: "text extracted", observation, metadata: { text: observation.text } }
    }

    if (call.type === "go_back") {
      await withAbort(page.goBack({ waitUntil: "domcontentloaded" }), ctx.abortSignal)
      return { ok: true, message: "went back", observation: await this.observe(ctx), metadata: {} }
    }

    if (call.type === "go_forward") {
      await withAbort(page.goForward({ waitUntil: "domcontentloaded" }), ctx.abortSignal)
      return { ok: true, message: "went forward", observation: await this.observe(ctx), metadata: {} }
    }

    return { ok: false, message: `Unsupported Playwright tool: ${(call as BrowserToolCall).type}`, observation: await this.observe(ctx), metadata: {} }
  }

  async close(_ctx: RuntimeContext): Promise<void> {
    await this.context?.close().catch(() => {})
    await this.browser?.close().catch(() => {})
    this.page = null
    this.context = null
    this.browser = null
  }

  private async launchBrowser(): Promise<Browser> {
    const headless = resolvePlaywrightHeadless(this.options)
    if (this.options.browserName === "firefox") return firefox.launch({ headless })
    if (this.options.browserName === "webkit") return webkit.launch({ headless })
    try {
      return await chromium.launch({ headless })
    } catch (error) {
      const executablePath = findCachedChromiumExecutable()
      if (executablePath) return chromium.launch({ headless, executablePath })
      throw error
    }
  }

  private requirePage(): Page {
    if (!this.page) throw new Error("PlaywrightEnvironment has not been reset")
    return this.page
  }

  private locatorForTarget(page: Page, target: {
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

  private async readObservation(page: Page): Promise<Observation> {
    const [title, text, interactiveElements] = await Promise.all([
      page.title().catch(() => null),
      page.locator("body").innerText().catch(() => null),
      page.evaluate(() => {
        const candidates = Array.from(
          document.querySelectorAll<HTMLElement>(
            "a,button,input,textarea,select,[role],[tabindex],[contenteditable='true']",
          ),
        ).slice(0, 50)

        return candidates.map((element, index) => {
          const rect = element.getBoundingClientRect()
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
      screenshotPath: this.lastScreenshotPath,
      interactiveElements,
      metadata: {},
    }
  }
}

export function resolvePlaywrightHeadless(options: Pick<PlaywrightEnvironmentOptions, "headless">): boolean {
  return options.headless ?? false
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

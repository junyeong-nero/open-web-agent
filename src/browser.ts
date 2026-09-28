import { existsSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { chromium, firefox, webkit, type Browser, type BrowserContext, type Locator, type Page } from "playwright"

export interface BrowserOptions {
  headless?: boolean
  browser?: "chromium" | "firefox" | "webkit"
  executablePath?: string
  /** Attach to an already running Chromium (e.g. `http://127.0.0.1:9222`) instead of launching one. */
  cdpUrl?: string
  /** Persistent profile directory (cookies/logins survive restarts). */
  userDataDir?: string
  viewport?: { width: number; height: number }
  /** Snapshots longer than this are truncated. */
  maxSnapshotChars?: number
  /** Per-action timeout; failing fast lets the model re-plan. */
  actionTimeoutMs?: number
}

const REF_PATTERN = /^(f\d+)?e\d+$/

/** One browser, one context, one "current" page that follows newly opened tabs. */
export class BrowserSession {
  private browser?: Browser
  private context?: BrowserContext
  private current?: Page
  private opening?: Promise<Page>
  private interrupted = false
  private tabIds = new Map<Page, string>()
  private nextTabId = 1

  constructor(readonly options: BrowserOptions = {}) {}

  /** The current page URL without launching or changing tabs. */
  get currentUrl(): string | undefined {
    return this.current && !this.current.isClosed() ? this.current.url() : undefined
  }

  get started(): boolean {
    return this.current !== undefined
  }

  async page(): Promise<Page> {
    if (this.interrupted) throw new Error("Browser operation cancelled")
    if (this.current && !this.current.isClosed()) return this.current
    this.opening ??= this.open().finally(() => {
      this.opening = undefined
    })
    return this.opening
  }

  async snapshot(): Promise<string> {
    const page = await this.page()
    const tree = await page.ariaSnapshot({ mode: "ai" })
    const max = this.options.maxSnapshotChars ?? 40_000
    const body = tree.length > max ? `${tree.slice(0, max)}\n… [snapshot truncated at ${max} chars]` : tree
    return `Page URL: ${page.url()}\nPage title: ${await page.title()}\nPage tab: ${this.track(page)}\nSnapshot:\n${body}`
  }

  async tabs(): Promise<Array<{ id: string; title: string; url: string; current: boolean }>> {
    await this.page()
    const tabs = []
    for (const page of this.context!.pages()) {
      if (page.isClosed()) continue
      const id = this.track(page)
      try {
        tabs.push({ id, title: await page.title(), url: page.url(), current: page === this.current })
      } catch (error) { if (!page.isClosed()) throw error }
    }
    return tabs
  }

  async selectTab(id: string): Promise<void> {
    if (this.interrupted) throw new Error("Browser operation cancelled")
    const page = [...this.tabIds].find(([, tabId]) => tabId === id)?.[0]
    if (!page || page.isClosed()) throw new Error(`Unknown or closed tab "${id}". Call browser_tabs for current tab IDs.`)
    await page.bringToFront()
    this.current = page
  }

  async locator(ref: string): Promise<Locator> {
    if (!REF_PATTERN.test(ref)) {
      throw new Error(`"${ref}" is not a snapshot ref (expected e.g. "e12"). Take a browser_snapshot and use a [ref=…] value.`)
    }
    return (await this.page()).locator(`aria-ref=${ref}`)
  }

  /** Quiesce the old action before the serialized queue may start another task. */
  async cancelPending(pending: Promise<unknown>): Promise<void> {
    this.interrupted = true
    try {
      await this.close()
      await pending.catch(() => {})
    } finally { this.interrupted = false }
  }

  async close(): Promise<void> {
    await this.opening?.catch(() => {})
    const browser = this.browser
    const context = this.context
    this.browser = this.context = this.current = undefined
    this.tabIds.clear()
    if (this.options.cdpUrl) {
      await browser?.close().catch(() => {})
      return
    }
    await context?.close().catch(() => {})
    await browser?.close().catch(() => {})
  }

  private async open(): Promise<Page> {
    const context = await this.openContext()
    this.context = context
    context.on("page", (page) => this.follow(page))
    for (const page of context.pages()) this.track(page)
    const page = context.pages()[0] ?? (await context.newPage())
    this.follow(page)
    return page
  }

  private follow(page: Page): void {
    this.track(page)
    this.current = page
  }

  private track(page: Page): string {
    const existing = this.tabIds.get(page)
    if (existing) return existing
    const id = `t${this.nextTabId++}`
    this.tabIds.set(page, id)
    page.setDefaultTimeout(this.options.actionTimeoutMs ?? 10_000)
    page.on("close", () => {
      this.tabIds.delete(page)
      if (this.current !== page) return
      this.current = this.context?.pages().at(-1)
    })
    return id
  }

  private async openContext(): Promise<BrowserContext> {
    const { options } = this
    const viewport = options.viewport ?? { width: 1280, height: 800 }

    if (options.cdpUrl) {
      this.browser = await chromium.connectOverCDP(options.cdpUrl)
      return this.browser.contexts()[0] ?? (await this.browser.newContext({ viewport }))
    }

    const type = options.browser === "firefox" ? firefox : options.browser === "webkit" ? webkit : chromium
    const launch = { headless: options.headless ?? false, executablePath: options.executablePath }

    if (options.userDataDir) {
      return withExecutableFallback(type === chromium, launch, (opts) =>
        type.launchPersistentContext(options.userDataDir as string, { ...opts, viewport }),
      )
    }
    this.browser = await withExecutableFallback(type === chromium, launch, (opts) => type.launch(opts))
    return this.browser.newContext({ viewport })
  }
}

/** Playwright pins an exact browser build; fall back to any cached Chromium when that build is missing. */
async function withExecutableFallback<T>(
  isChromium: boolean,
  launch: { headless: boolean; executablePath?: string },
  start: (opts: { headless: boolean; executablePath?: string }) => Promise<T>,
): Promise<T> {
  try {
    return await start(launch)
  } catch (error) {
    const fallback = !launch.executablePath && isChromium ? findCachedChromium() : undefined
    if (!fallback) throw error
    return start({ ...launch, executablePath: fallback })
  }
}

function findCachedChromium(): string | undefined {
  const roots = [
    process.env.PLAYWRIGHT_BROWSERS_PATH,
    join(process.env.HOME ?? "", ".cache", "ms-playwright"),
    join(process.env.HOME ?? "", "Library", "Caches", "ms-playwright"),
  ].filter((root): root is string => Boolean(root) && existsSync(root as string))

  for (const root of roots) {
    const builds = readdirSync(root).filter((entry) => entry.startsWith("chromium-")).sort().reverse()
    for (const build of builds) {
      const candidate = [
        join(root, build, "chrome-linux", "chrome"),
        join(root, build, "chrome-linux64", "chrome"),
        join(root, build, "chrome-mac-arm64", "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing"),
        join(root, build, "chrome-mac", "Chromium.app", "Contents", "MacOS", "Chromium"),
        join(root, build, "chrome-win", "chrome.exe"),
      ].find((path) => existsSync(path))
      if (candidate) return candidate
    }
  }
  return undefined
}

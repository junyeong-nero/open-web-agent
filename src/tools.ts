import { z } from "zod"
import { errors, type Download, type Frame, type Locator, type Page, type Request, type Response } from "playwright"
import type { BrowserSession } from "./browser"
import type { ContentPart, ToolSpec } from "./model/types"

export interface ToolResult {
  /** What happened, always kept in the transcript. */
  text: string
  /** Page state (or an unavailable-state marker). The agent keeps only the latest one in context. */
  snapshot?: string
  /** Large observed page body; only the newest is kept in model context. */
  pageText?: boolean
  image?: { mimeType: string; data: string }
  isError?: boolean
  structuredContent?: Record<string, unknown>
}

export type Capability = "core" | "unsafe"

export interface BrowserTool {
  name: string
  description: string
  schema: z.ZodObject
  readOnly: boolean
  capability: Capability
  run(session: BrowserSession, args: any): Promise<ToolResult>
}

function tool<S extends z.ZodObject>(definition: {
  name: string
  description: string
  schema: S
  readOnly?: boolean
  capability?: Capability
  run(session: BrowserSession, args: z.infer<S>): Promise<ToolResult>
}): BrowserTool {
  return { readOnly: false, capability: "core", ...definition }
}

const ref = z.string().describe("Element ref from the latest snapshot, e.g. e12")
const element = z
  .string()
  .optional()
  .describe("Short human-readable description of the element, shown to humans approving the action")

/** Main-frame requests that can still change a snapshot. Streams (EventSource, WebSocket), beacons, images and fonts never hold it. */
const SETTLE_REQUESTS = new Set(["document", "stylesheet", "script", "xhr", "fetch"])
/** How long the URL, the accessibility tree and the tracked requests must stay unchanged for the page to count as settled. */
const SETTLE_QUIET_MS = 600
const SETTLE_POLL_MS = 150

interface Settling {
  /** Start comparing snapshots while the action still waits for its own navigation. */
  observe(): void
  /** Wait at most settleTimeoutMs more; resolves to a note when the page was still changing, and never rejects. */
  settle(): Promise<string>
  stop(): void
}

/**
 * Watch a page from just before an action until it settles: the main-frame documents, scripts, styles and data
 * requests started since then have finished, a new document has reached DOMContentLoaded, and the URL and the
 * accessibility tree have not changed for SETTLE_QUIET_MS. An empty tree has not rendered yet. Only request events
 * and ariaSnapshot, which runs in Playwright's utility world, are used, never page-world evaluate, so pages that
 * override `window.eval` settle too. Undefined when settling is off or the page cannot be watched.
 */
function watchSettling(session: BrowserSession, page: Page): Settling | undefined {
  const cap = session.options.settleTimeoutMs ?? 3_000
  if (!(cap > 0)) return undefined
  const quiet = Math.min(SETTLE_QUIET_MS, cap / 2)
  // Requests that started before the action, such as an open long poll, are never tracked.
  const pending = new Set<Request>()
  let activity = performance.now()
  const touch = () => { activity = performance.now() }
  const onRequest = (request: Request) => {
    try {
      if (SETTLE_REQUESTS.has(request.resourceType()) && request.frame() === page.mainFrame()) pending.add(request)
    } catch { /* A service worker request has no frame. */ }
  }
  const onFinished = (request: Request) => { if (pending.delete(request)) touch() }
  const onNavigated = (frame: Frame) => { if (frame === page.mainFrame()) touch() }
  let stopped = false
  let wake = () => {}
  const stop = () => {
    stopped = true
    wake()
    try {
      page.off("request", onRequest)
      page.off("requestfinished", onFinished)
      page.off("requestfailed", onFinished)
      page.off("framenavigated", onNavigated)
      page.off("domcontentloaded", touch)
      page.off("load", touch)
    } catch { /* Nothing was attached to a page that cannot be watched. */ }
  }
  try {
    page.on("request", onRequest)
    page.on("requestfinished", onFinished)
    page.on("requestfailed", onFinished)
    page.on("framenavigated", onNavigated)
    page.on("domcontentloaded", touch)
    page.on("load", touch)
  } catch {
    stop()
    return undefined
  }

  let deadline = Infinity
  let loop: Promise<string> | undefined
  const run = async (): Promise<string> => {
    let previous: string | undefined
    while (!stopped) {
      if (performance.now() >= deadline) return "\nThe page may still be changing."
      const deciding = deadline < Infinity
      let took = 0
      try {
        // A new tab opened by the action is the page the snapshot shows.
        const current = await session.page()
        if (deciding) await current.waitForLoadState("domcontentloaded", { timeout: Math.max(1, deadline - performance.now()) })
        if (current !== page || !pending.size) {
          const started = performance.now()
          const tree = await current.ariaSnapshot({ mode: "ai", timeout: Math.max(1, Math.min(deadline, started + 1_000) - started) })
          took = performance.now() - started
          const url = current.url()
          const state = `${url}\n${tree}`
          if (previous !== undefined && state !== previous) touch()
          previous = state
          // An empty tree has not rendered yet, unless the tab is blank on purpose.
          if (deciding && (tree || url === "about:blank") && performance.now() - activity >= quiet) return ""
        }
      } catch (error) {
        // A timeout means the page is still busy; anything else, such as a closed page or a cancelled session, ends the wait.
        if (!(error instanceof errors.TimeoutError)) return ""
        touch()
      }
      const now = performance.now()
      // Poll every SETTLE_POLL_MS and when the quiet period ends, but spend at most half the time taking snapshots.
      const next = activity + quiet > now ? Math.min(SETTLE_POLL_MS, activity + quiet - now) : SETTLE_POLL_MS
      await new Promise<void>((resolve) => {
        wake = resolve
        setTimeout(resolve, Math.max(0, Math.min(Math.max(next, took), deadline - now)))
      })
    }
    return ""
  }
  return {
    observe() {
      touch()
      loop ??= run()
    },
    async settle() {
      if (stopped) return ""
      deadline = performance.now() + cap
      wake()
      if (!loop) {
        touch()
        loop = run()
      }
      try { return await loop } finally { stop() }
    },
    stop,
  }
}

/** Run a page action, wait for any navigation it caused and for the page to settle, and return the fresh snapshot. */
async function act(session: BrowserSession, summary: string, action: (page: Page) => Promise<unknown>): Promise<ToolResult> {
  const page = await session.page()
  const settling = watchSettling(session, page)
  const navigated = page
    .waitForEvent("framenavigated", { predicate: (frame) => frame === page.mainFrame(), timeout: 750 })
    .then(() => true, () => false)
  try {
    await action(page)
  } catch (error) {
    settling?.stop()
    throw error
  }
  settling?.observe()
  if (await navigated) await page.waitForLoadState("domcontentloaded", { timeout: 10_000 }).catch(() => {})
  return snapshotAfterAction(session, summary, settling)
}

/** A committed document is usable even when its response body is still loading. */
async function navigate(session: BrowserSession, summary: string, action: (page: Page) => Promise<Response | null>): Promise<ToolResult> {
  const page = await session.page()
  const timeout = session.options.actionTimeoutMs ?? 10_000
  const started = performance.now()
  // A navigation that becomes a download never commits, so keep what the server sent to explain it.
  const sent: { response?: Response; download?: Download } = {}
  const onResponse = (response: Response) => {
    if (response.request().isNavigationRequest() && response.frame() === page.mainFrame()) sent.response = response
  }
  const onDownload = (download: Download) => { sent.download = download }
  page.on("response", onResponse)
  page.on("download", onDownload)
  const settling = watchSettling(session, page)
  let response: Response | null
  try {
    // Connection failures and timeouts before commit must remain action failures.
    response = await action(page)
  } catch (error) {
    settling?.stop()
    // goto rejects with "Download is starting" and a history navigation with net::ERR_ABORTED, before the download event fires.
    const starting = String(error).includes("Download is starting")
    if (!sent.download && (starting || String(error).includes("net::ERR_ABORTED"))) {
      await page.waitForEvent("download", { timeout: 2_000 }).catch(() => {})
    }
    if (!sent.download && !starting) throw error
    throw new Error(downloadMessage(sent))
  } finally {
    page.off("response", onResponse)
    page.off("download", onDownload)
  }
  if (response) {
    if (response.status() >= 400) summary += `\nThe server responded with HTTP ${response.status()}.`
    try {
      await page.waitForLoadState("domcontentloaded", {
        timeout: timeout === 0 ? 0 : Math.max(1, timeout - (performance.now() - started)),
      })
    } catch (error) {
      // The action timeout is spent, so a page that is still loading is returned without settling.
      settling?.stop()
      if (!(error instanceof errors.TimeoutError)) throw error
      summary += "\nThe page may still be loading."
    }
  }
  return snapshotAfterAction(session, summary, settling)
}

/** Explain a download so the agent stops reopening a URL whose file the browser cannot show. */
function downloadMessage({ response, download }: { response?: Response; download?: Download }): string {
  const type = response?.headers()["content-type"]?.split(";")[0]?.trim().toLowerCase()
  const name = download?.suggestedFilename()
  const details = [type && `content-type \`${type}\``, name && `filename \`${name}\``].filter(Boolean).join(", ")
  const pdf = type === "application/pdf" || /\.pdf$/i.test(name ?? "")
  return `The server sent a file${details ? ` (${details})` : ""} instead of a web page; the browser cannot display it. Opening the same URL again gives the same result.`
    + (pdf ? " For a PDF, look for an HTML version of the same document, such as its abstract or landing page." : "")
}

/** Retain a compact record of the observed landing page when the snapshot is superseded. */
function snapshotResult(summary: string, snapshot: string): ToolResult {
  const headers = /^Page URL: ([^\n]*)\nPage title: ([\s\S]*?)\nPage tab:/.exec(snapshot)
  const compact = (value: string, max: number) => {
    const line = value.replace(/\s+/g, " ").trim()
    return line.length > max ? `${line.slice(0, max - 1)}…` : line
  }
  const landing = headers ? `\nLanding URL: ${compact(headers[1]!, 160)} | Title: ${compact(headers[2]!, 120)}` : ""
  return { text: summary + landing, snapshot }
}

/** Playwright call log lines that only narrate its retry loop; the reasons between them are kept. */
const RETRY_NARRATION = /^(?:attempting .+ action|retrying .+ action|waiting \d+ms$|waiting for element to be |element is visible|scrolling into view if needed$|done scrolling$)/

/** The error message plus each distinct reason from Playwright's call log, in at most 600 characters. */
function failureReason(error: unknown): string {
  const message = (error instanceof Error ? error.message : String(error)).replace(/\u001b\[[\d;]*m/g, "").trim()
  const [head, ...logs] = message.split(/\n+Call log:\n/)
  // Every retry logs the same reasons again; drop bullets and Playwright's "2 ×" counts before comparing.
  const reasons = new Set(logs.join("\n").split("\n").map((line) => line.trim().replace(/^(?:\d+ × )?(?:- )?/, "")).filter((line) => line && !RETRY_NARRATION.test(line)))
  // Shorten long element previews in the middle so a trailing "intercepts pointer events" survives.
  const text = [head, ...[...reasons].map((line) => `- ${line.length > 200 ? `${line.slice(0, 139)}…${line.slice(-60)}` : line}`)].join("\n")
  return text.length > 600 ? `${text.slice(0, 599)}…` : text
}

/** A failed observation must not turn an already completed action into a retryable failure. */
async function snapshotAfterAction(session: BrowserSession, summary: string, settling?: Settling): Promise<ToolResult> {
  if (settling) summary += await settling.settle()
  try {
    return snapshotResult(summary, await session.snapshot())
  } catch (error) {
    return {
      text: `${summary}\nThe browser action completed, but its follow-up snapshot failed: ${failureReason(error)}\nDo not repeat the action just to recover the snapshot. Call browser_snapshot to inspect the current page before taking another action.`,
      // Supersede the previous snapshot so its refs are not presented as current state.
      snapshot: "[Current page state unavailable. Previous snapshot refs may be stale.]",
    }
  }
}

/**
 * Use a ref without waiting out the action timeout when its element is gone. Hydration and re-renders replace
 * elements, so the ref is re-identified once, by role and name, in a fresh snapshot of the same tab and URL;
 * otherwise the tool fails at once with that snapshot.
 */
async function withRef(session: BrowserSession, ref: string, use: (target: Locator, ref: string) => Promise<ToolResult>): Promise<ToolResult> {
  const target = await session.locator(ref)
  // Waiting cannot help: a replacement element never takes over the old ref, and a ref into a removed frame throws.
  if (await target.count().catch(() => 0)) return use(target, ref)

  const previous = session.lastSnapshot
  const snapshot = await session.snapshot()
  const current = session.lastSnapshot
  const before = refIdentities(previous?.tree ?? "")
  const identity = before.get(ref)
  let replacement: string | undefined
  if (identity !== undefined && current && previous?.page === current.page && previous.url === current.url) {
    const matches = [...refIdentities(current.tree)].filter(([, other]) => other === identity).map(([match]) => match)
    // A single match counts unless the previous snapshot already showed it as a separate element.
    replacement = matches.length === 1 && (matches[0] === ref || before.get(matches[0]) !== identity) ? matches[0] : undefined
  }
  if (!replacement) {
    const reason = identity === undefined ? `ref ${ref} is not on the page` : `ref ${ref} (${identity}) is no longer on the page`
    return { ...snapshotResult(`${reason}, so nothing was done. Use a ref from this new snapshot.`, snapshot), isError: true }
  }
  // A read returns no snapshot of its own; keep the fresh one, whose refs are now the valid ones.
  const result = { snapshot, ...(await use(await session.locator(replacement), replacement)) }
  return replacement === ref ? result : { ...result, text: `ref ${ref} was stale; used ${replacement} (${identity})\n${result.text}` }
}

/** Map each ref in a snapshot tree to its element's role and name, e.g. `link "Pricing"`, without states like [active]. */
function refIdentities(tree: string): Map<string, string> {
  const identities = new Map<string, string>()
  for (const line of tree.split("\n")) {
    // `- key`, `- key:` or `- key: text`, where a key whose name needs YAML quoting is single-quoted.
    const match = /^\s*- (?:'((?:[^']|'')*)'|(.*?))(?::(?: .*)?)?$/.exec(line)
    const key = match?.[1]?.replaceAll("''", "'") ?? match?.[2] ?? ""
    const attributes = /(?: \[[^\]]*\])*$/.exec(key)![0]
    const ref = /\[ref=([^\]]+)\]/.exec(attributes)?.[1]
    if (ref) identities.set(ref, key.slice(0, key.length - attributes.length))
  }
  return identities
}

/** Playwright's multi-character key names (US layout codes and modifier aliases) by lowercase name, plus common aliases. */
const KEY_NAMES = new Map<string, string>([
  ...[
    "Escape", "Enter", "Tab", "Backspace", "Delete", "Insert", "Home", "End", "PageUp", "PageDown",
    "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Space", "CapsLock", "NumLock", "ScrollLock", "PrintScreen", "Pause", "ContextMenu",
    "Shift", "ShiftLeft", "ShiftRight", "Control", "ControlLeft", "ControlRight", "ControlOrMeta",
    "Alt", "AltLeft", "AltRight", "AltGraph", "Meta", "MetaLeft", "MetaRight",
    "Backquote", "Minus", "Equal", "Backslash", "BracketLeft", "BracketRight", "Semicolon", "Quote", "Comma", "Period", "Slash",
    "NumpadAdd", "NumpadSubtract", "NumpadMultiply", "NumpadDivide", "NumpadDecimal", "NumpadEnter",
    "AudioVolumeMute", "AudioVolumeDown", "AudioVolumeUp", "MediaTrackNext", "MediaTrackPrevious", "MediaPlayPause",
    ...Array.from({ length: 12 }, (_, index) => `F${index + 1}`),
    ...Array.from({ length: 10 }, (_, digit) => [`Digit${digit}`, `Numpad${digit}`]).flat(),
    ..."ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("").map((letter) => `Key${letter}`),
  ].map((name) => [name.toLowerCase(), name] as const),
  ["esc", "Escape"], ["ctrl", "Control"], ["cmd", "Meta"], ["command", "Meta"], ["del", "Delete"],
])

/** Spell named keys the way Playwright expects (END → End, CTRL+A → Control+A); single characters keep their case. */
function playwrightKey(key: string): string {
  return key.split("+").map((part) => KEY_NAMES.get(part.toLowerCase()) ?? part).join("+")
}

export const TOOLS: BrowserTool[] = [
  tool({
    name: "browser_tabs",
    description: "List open tabs with stable IDs, titles, URLs and the current tab. Tab IDs are distinct from element refs.",
    schema: z.object({}),
    readOnly: true,
    run: async (session) => ({ text: JSON.stringify(await session.tabs(), null, 2) }),
  }),
  tool({
    name: "browser_select_tab",
    description: "Select an existing tab by its ID from browser_tabs or Page tab in a snapshot. Returns fresh refs for that tab without navigating or reloading it.",
    schema: z.object({ tabId: z.string().regex(/^t[1-9]\d*$/).describe("Tab ID, e.g. t1 (not an element ref)") }),
    run: async (session, { tabId }) => {
      await session.selectTab(tabId)
      return snapshotAfterAction(session, `Selected tab ${tabId}`)
    },
  }),
  tool({
    name: "browser_navigate",
    description: "Open a URL in the current tab.",
    schema: z.object({ url: z.string().describe("Absolute URL, e.g. https://example.com") }),
    run: (session, { url }) =>
      navigate(session, `Navigated to ${url}`, (page) => page.goto(url, { waitUntil: "commit" })),
  }),
  tool({
    name: "browser_go_back",
    description: "Go back to the previous page in history.",
    schema: z.object({}),
    run: (session) => navigate(session, "Went back", (page) => page.goBack({ waitUntil: "commit" })),
  }),
  tool({
    name: "browser_snapshot",
    description:
      "Capture the accessibility snapshot of the current page. Elements carry [ref=…] handles that the other tools accept.",
    schema: z.object({}),
    readOnly: true,
    run: async (session) => snapshotResult("Captured page snapshot", await session.snapshot()),
  }),
  tool({
    name: "browser_click",
    description: "Click an element by its snapshot ref.",
    schema: z.object({
      ref,
      element,
      doubleClick: z.boolean().optional(),
      button: z.enum(["left", "right", "middle"]).optional(),
    }),
    run: (session, { ref, element, doubleClick, button }) =>
      withRef(session, ref, (target) => act(session, `Clicked ${element ?? ref}`, () =>
        doubleClick ? target.dblclick({ button }) : target.click({ button }),
      )),
  }),
  tool({
    name: "browser_type",
    description: "Replace the value of an editable element, optionally pressing Enter afterwards.",
    schema: z.object({
      ref,
      element,
      text: z.string(),
      submit: z.boolean().optional().describe("Press Enter after typing"),
    }),
    run: (session, { ref, element, text, submit }) =>
      withRef(session, ref, (target) => act(session, `Typed into ${element ?? ref}${submit ? " and submitted" : ""}`, async () => {
        await target.fill(text)
        if (submit) await target.press("Enter")
      })),
  }),
  tool({
    name: "browser_select_option",
    description: "Select one or more options in a <select> element.",
    schema: z.object({ ref, element, values: z.array(z.string()).min(1).describe("Option values or labels") }),
    run: (session, { ref, element, values }) =>
      withRef(session, ref, (target) => act(session, `Selected ${values.join(", ")} in ${element ?? ref}`, () => target.selectOption(values))),
  }),
  tool({
    name: "browser_hover",
    description: "Hover the mouse over an element.",
    schema: z.object({ ref, element }),
    run: (session, { ref, element }) => withRef(session, ref, (target) => act(session, `Hovered ${element ?? ref}`, () => target.hover())),
  }),
  tool({
    name: "browser_press_key",
    description: "Press a key or chord on the focused element, e.g. Enter, Escape, ArrowDown, Control+A.",
    schema: z.object({ key: z.string() }),
    run: (session, args) => {
      const key = playwrightKey(args.key)
      return act(session, `Pressed ${key}`, (page) => page.keyboard.press(key).catch(async (error) => {
        // Playwright leaves a chord's earlier keys held down when a later key is unknown (CTRL+RETURN).
        for (const part of key.split("+").slice(0, -1).reverse()) await page.keyboard.up(part).catch(() => {})
        throw error
      }))
    },
  }),
  tool({
    name: "browser_scroll",
    description: "Scroll the page (or the element under a ref) to load lazy content.",
    schema: z.object({
      direction: z.enum(["up", "down"]),
      pixels: z.number().int().positive().optional().describe("Default 800"),
      ref: ref.optional(),
    }),
    run: async (session, { direction, pixels = 800, ref }) => {
      const scroll = (target?: Locator) => act(session, `Scrolled ${direction} ${pixels}px`, async (page) => {
        if (target) await target.hover()
        await page.mouse.wheel(0, direction === "down" ? pixels : -pixels)
        await page.waitForTimeout(300)
      })
      return ref ? withRef(session, ref, scroll) : scroll()
    },
  }),
  tool({
    name: "browser_wait_for",
    description: "Wait for text to appear, text to disappear, or a number of seconds.",
    schema: z.object({
      text: z.string().optional(),
      textGone: z.string().optional(),
      seconds: z.number().positive().max(30).optional(),
    }),
    run: async (session, { text, textGone, seconds }) => {
      const page = await session.page()
      if (seconds) await page.waitForTimeout(seconds * 1000)
      if (text) await page.getByText(text).first().waitFor({ state: "visible", timeout: 15_000 })
      if (textGone) await page.getByText(textGone).first().waitFor({ state: "hidden", timeout: 15_000 })
      return snapshotAfterAction(session, "Wait finished")
    },
  }),
  tool({
    name: "browser_get_text",
    description: "Return the visible text of the page (or of one element). Use it to read content for the answer.",
    schema: z.object({
      ref: ref.optional(),
      offset: z.number().int().min(0).optional().describe("Character offset to start reading from, as given in a truncation notice. Default 0"),
    }),
    readOnly: true,
    run: async (session, { ref, offset = 0 }) => {
      // `used` is the ref actually read, which differs from `ref` after a stale ref was re-identified.
      const read = async (target: Locator, used?: string): Promise<ToolResult> => {
        const text = (await target.innerText()).replace(/\n{3,}/g, "\n\n").trim()
        // No pageText flag, so an out-of-range read does not evict the part read last.
        if (offset > 0 && offset >= text.length) return { text: `No text at offset=${offset}: the text is ${text.length} chars long.`, isError: true }
        const max = session.options.maxSnapshotChars ?? 40_000
        // Part boundaries never split a surrogate pair (one character, e.g. an emoji).
        const splitsPair = (index: number) => /[\uD800-\uDBFF]/.test(text.charAt(index - 1)) && /[\uDC00-\uDFFF]/.test(text.charAt(index))
        const start = splitsPair(offset) ? offset - 1 : offset
        let end = Math.min(start + max, text.length)
        if (splitsPair(end)) end += 1
        const part = text.slice(start, end)
        const range = `showing chars ${start}–${end} of ${text.length}`
        if (end < text.length) {
          return { pageText: true, text: `${part}\n… [text truncated: ${range}; call browser_get_text with ${used ? `ref=${used} and ` : ""}offset=${end} to read more]` }
        }
        return { pageText: true, text: offset > 0 ? `${part}\n[end of text: ${range}]` : part || "(no text)" }
      }
      return ref ? withRef(session, ref, read) : read((await session.page()).locator("body"))
    },
  }),
  tool({
    name: "browser_screenshot",
    description: "Take a PNG screenshot of the viewport. Use snapshots, not screenshots, to find refs.",
    schema: z.object({ fullPage: z.boolean().optional() }),
    readOnly: true,
    run: async (session, { fullPage }) => {
      const png = await (await session.page()).screenshot({ fullPage, type: "png" })
      return { text: "Captured screenshot", image: { mimeType: "image/png", data: png.toString("base64") } }
    },
  }),
  tool({
    name: "browser_evaluate",
    description: "Evaluate a JavaScript expression in the page and return the JSON-serialised result.",
    schema: z.object({ expression: z.string().describe("e.g. document.querySelectorAll('a').length") }),
    capability: "unsafe",
    run: async (session, { expression }) => {
      const result = await (await session.page()).evaluate(expression)
      return { text: JSON.stringify(result, null, 2) ?? "undefined" }
    },
  }),
]

export function selectTools(capabilities: Capability[] = ["core"]): BrowserTool[] {
  return TOOLS.filter((candidate) => capabilities.includes(candidate.capability))
}

export function toolSpec(definition: BrowserTool): ToolSpec {
  const { $schema: _ignored, ...inputSchema } = z.toJSONSchema(definition.schema) as Record<string, unknown>
  return { name: definition.name, description: definition.description, inputSchema }
}

/** Models often send null for an optional argument they mean to omit; a null required argument still fails validation. */
function omitNullOptionals(schema: z.ZodObject, args: unknown): unknown {
  if (typeof args !== "object" || args === null || Array.isArray(args)) return args
  const input: Record<string, unknown> = { ...args }
  for (const [key, field] of Object.entries<z.ZodType>(schema.shape)) {
    if (input[key] === null && field.safeParse(undefined).success) delete input[key]
  }
  return input
}

/** Validate arguments, run the tool, and turn any failure into an error result the model can react to. */
export async function callTool(
  tools: BrowserTool[],
  session: BrowserSession,
  name: string,
  args: unknown,
): Promise<ToolResult> {
  const definition = tools.find((candidate) => candidate.name === name)
  if (!definition) return { text: `Unknown tool "${name}"`, isError: true }

  const parsed = definition.schema.safeParse(omitNullOptionals(definition.schema, args ?? {}))
  if (!parsed.success) {
    return { text: `Invalid arguments for ${name}: ${z.prettifyError(parsed.error)}`, isError: true }
  }
  try {
    return await definition.run(session, parsed.data)
  } catch (error) {
    return { text: `${name} failed: ${failureReason(error)}\nTake a new browser_snapshot if the page may have changed.`, isError: true }
  }
}

export function resultContent(result: ToolResult): ContentPart[] {
  const parts: ContentPart[] = [{ type: "text", text: result.text }]
  if (result.snapshot) parts.push({ type: "text", text: result.snapshot })
  if (result.image) parts.push({ type: "image", ...result.image })
  return parts
}

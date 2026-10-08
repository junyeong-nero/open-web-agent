import { z } from "zod"
import { errors, type Download, type Locator, type Page, type Response } from "playwright"
import type { BrowserSession } from "./browser"
import { interruptible } from "./cancel"
import type { ContentPart, ModelAdapter, ModelResponse, ToolSpec, Usage } from "./model/types"

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
  /** A model request the tool made, which the agent records apart from its own model calls. */
  modelCall?: ModelCall
}

/** browser_locate's request to the grounding model, with what the agent records for a model call. */
export interface ModelCall {
  role: "grounding"
  text?: string
  model?: string
  durationMs: number
  usage?: Usage
}

export type Capability = "core" | "unsafe" | "vision"

/** Settings given once to `selectTools`; only browser_locate, in the vision capability, uses them. */
export interface ToolOptions {
  /** Answers browser_locate from a screenshot. Without it, browser_locate is not offered. */
  groundingModel?: ModelAdapter
  /** The grounding model answers on a 0–n scale on both axes (e.g. 1000) instead of in screenshot pixels. */
  groundingScale?: number
  /** How long browser_locate waits for the grounding model before it fails (default 30000). */
  groundingTimeoutMs?: number
}

/** What a tool's run gets besides the session and its arguments: its options, and the caller's signal for a model request. */
export interface ToolContext extends ToolOptions {
  signal?: AbortSignal
}

export interface BrowserTool {
  name: string
  description: string
  schema: z.ZodObject
  readOnly: boolean
  capability: Capability
  run(session: BrowserSession, args: any, context: ToolContext): Promise<ToolResult>
}

function tool<S extends z.ZodObject>(definition: {
  name: string
  description: string
  schema: S
  readOnly?: boolean
  capability?: Capability
  run(session: BrowserSession, args: z.infer<S>, context: ToolContext): Promise<ToolResult>
}): BrowserTool {
  return { readOnly: false, capability: "core", ...definition }
}

const ref = z.string().describe("Element ref from the latest snapshot, e.g. e12")
const element = z
  .string()
  .optional()
  .describe("Short human-readable description of the element, shown to humans approving the action")

/** Run a page action, wait for any navigation it caused, and return the fresh snapshot. */
async function act(session: BrowserSession, summary: string, action: (page: Page) => Promise<unknown>): Promise<ToolResult> {
  const page = await session.page()
  const navigated = page
    .waitForEvent("framenavigated", { predicate: (frame) => frame === page.mainFrame(), timeout: 750 })
    .then(() => true, () => false)
  await action(page)
  if (await navigated) await page.waitForLoadState("domcontentloaded", { timeout: 10_000 }).catch(() => {})
  return snapshotAfterAction(session, summary)
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
  let response: Response | null
  try {
    // Connection failures and timeouts before commit must remain action failures.
    response = await action(page)
  } catch (error) {
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
      if (!(error instanceof errors.TimeoutError)) throw error
      summary += "\nThe page may still be loading."
    }
  }
  return snapshotAfterAction(session, summary)
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
async function snapshotAfterAction(session: BrowserSession, summary: string): Promise<ToolResult> {
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

/** A trial click of a checkbox or radio that has not gone through by then means something covers it. */
const COVERED_AFTER_MS = 300
/** The other steps of the covering-label check answer at once unless the page is busy; the click keeps its own timeout. */
const LABEL_CHECK_TIMEOUT_MS = 1_000

/**
 * Sites often hide a checkbox or radio under its own styled label, so Playwright waits out the action timeout because
 * the label intercepts the click. A person clicks the label there, and the label toggles its control. Return that
 * label with the control's center as a position on it, but only when a trial click of the control fails and a trial
 * click of the label at that point succeeds: an unrelated overlay or another control's label is left to fail as before.
 * Only Playwright actions touch the page, since they run in Playwright's own world, while page-world evaluate breaks
 * on sites that replace window.eval. If any step fails, the click goes to the control as usual.
 */
async function coveringLabel(session: BrowserSession, target: Locator, ref: string) {
  // Ordinary clicks skip all of this; only refs the snapshot shows as a checkbox or radio pay for it.
  if (!/^(?:checkbox|radio)\b/.test(refIdentities(session.lastSnapshot?.tree ?? "").get(ref) ?? "")) return undefined
  const timeout = LABEL_CHECK_TIMEOUT_MS
  const succeeds = (action: Promise<unknown>) => action.then(() => true, () => false)
  try {
    // Its labels: an enclosing label without `for` around no other control, and any label naming its id.
    const id = await target.getAttribute("id", { timeout })
    let labels = target.locator('xpath=ancestor::label[not(@for)][count(.//input[not(@type="hidden")] | .//button | .//select | .//textarea) = 1]')
    if (id) labels = labels.or(target.locator("xpath=ancestor::*[last()]").locator(`label[for=${JSON.stringify(id)}]`))
    const count = await labels.count()
    // A control that takes the click itself keeps the normal click, and so does a disabled one, which Playwright waits for.
    if (!count || await succeeds(target.click({ trial: true, timeout: COVERED_AFTER_MS })) || !(await target.isEnabled({ timeout }))) return undefined
    const box = await target.boundingBox({ timeout })
    if (!box) return undefined
    const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
    const covers = (area: { x: number; y: number; width: number; height: number } | null) =>
      !!area && center.x >= area.x && center.x <= area.x + area.width && center.y >= area.y && center.y <= area.y + area.height
    for (let index = 0; index < count; index++) {
      const label = labels.nth(index)
      const outer = await label.boundingBox({ timeout })
      // A click on a link or button inside the label goes to that element, not to the control.
      const inner = await Promise.all((await label.locator("a[href], button").all()).map((control) => control.boundingBox({ timeout })))
      if (!outer || inner.some(covers)) continue
      // Playwright adds the label's border to this position; the trial click checks the point it actually uses.
      const position = { x: center.x - outer.x, y: center.y - outer.y }
      if (await succeeds(label.click({ trial: true, position, timeout }))) {
        const text = (await label.innerText({ timeout }).catch(() => "")).replace(/\s+/g, " ").trim()
        return { label, position, text: text.length > 60 ? `${text.slice(0, 59)}…` : text }
      }
    }
  } catch {
    // A step that cannot run on this page must never be the reason the click fails.
  }
  return undefined
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

/** Ask for one point, in screenshot pixels unless the grounding model answers on a 0–`scale` range. */
function groundingPrompt({ width, height }: { width: number; height: number }, scale?: number): string {
  const units = scale
    ? `on a 0–${scale} scale on both axes, from the top-left corner (0, 0) to the bottom-right corner (${scale}, ${scale})`
    : `in pixels of the ${width}×${height} screenshot, counted from its top-left corner`
  return `You find one element in a screenshot of a web page. Reply with only the point to click on it as JSON {"x": <x>, "y": <y>}, ${units}. If the element is not in the screenshot, reply "not found".`
}

const NUMBER = String.raw`-?\d+(?:\.\d+)?`
/** A bracketed list of exactly `count` numbers, captured without the brackets. */
const numberList = (count: number) => String.raw`\[\s*(${NUMBER}(?:\s*,\s*${NUMBER}){${count - 1}})\s*\]`
/** The center of a box given as two corners, or the point itself. */
const center = (values: number[]) => values.length === 4 ? [(values[0]! + values[2]!) / 2, (values[1]! + values[3]!) / 2] : values

/**
 * The point a grounding model's reply names, in whole screenshot pixels, or undefined when it names none inside the
 * screenshot. The first format the reply holds is read:
 * 1. Gemini's `"box_2d": [ymin, xmin, ymax, xmax]` or `"point": [y, x]`, which are on a 0–1000 scale whatever was asked.
 * 2. `x` and `y` keys: `{"x": 300, "y": 240}`, `x=300`, or Molmo's `<point x="23.4" y="30">`.
 * 3. The first group of two numbers in parentheses, brackets or a tag, such as `(300, 240)`, `[300, 240]` or
 *    `<point>300 240</point>`, or of four, a box `[x1, y1, x2, y2]` such as Qwen's `bbox_2d`.
 * 4. A bare `300, 240`.
 * A box gives its center. Apart from Gemini's, values are screenshot pixels, or run 0–`scale` on both axes when `scale`
 * is set; values that are all between 0 and 1, with at least one fraction, are fractions of the screenshot.
 */
export function groundingPoint(reply: string, size: { width: number; height: number }, scale?: number): { x: number; y: number } | undefined {
  const toNumbers = (group: string) => group.split(/\s*,\s*|\s+/).map(Number)
  let read: { x: number; y: number; range?: number }
  const gemini = new RegExp(String.raw`\b(?:box_2d\b["']?\s*:\s*${numberList(4)}|point\b["']?\s*:\s*${numberList(2)})`).exec(reply)
  if (gemini) {
    const [y, x] = center(toNumbers(gemini[1] ?? gemini[2]!))
    read = { x: x!, y: y!, range: 1000 }
  } else {
    const keyed = ["x", "y"].map((key) => new RegExp(String.raw`\b${key}\b["']?\s*[:=]\s*["']?(${NUMBER})`, "i").exec(reply)?.[1])
    const grouped = [...reply.matchAll(new RegExp(String.raw`[(\[>]\s*(${NUMBER}(?:(?:\s*,\s*|\s+)${NUMBER}){1,3})\s*[)\]<]`, "g"))]
      .map((match) => toNumbers(match[1]!))
      .find((numbers) => numbers.length === 2 || numbers.length === 4)
    const bare = new RegExp(String.raw`(${NUMBER})\s*,\s*(${NUMBER})`).exec(reply)?.slice(1).map(Number)
    const values = keyed.every((value) => value !== undefined) ? keyed.map(Number) : grouped ?? bare
    if (!values) return undefined
    const [x, y] = center(values)
    const fractions = values.every((value) => Math.abs(value) <= 1) && values.some((value) => !Number.isInteger(value))
    read = { x: x!, y: y!, range: fractions ? 1 : scale }
  }
  const { x, y, range } = read
  const point = { x: Math.round(range ? (x * size.width) / range : x), y: Math.round(range ? (y * size.height) / range : y) }
  if (!(point.x >= 0 && point.y >= 0 && point.x <= size.width && point.y <= size.height)) return undefined
  // A point on the right or bottom edge, such as 1000 on a 0–1000 scale, becomes the last pixel.
  return { x: Math.min(point.x, size.width - 1), y: Math.min(point.y, size.height - 1) }
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
      withRef(session, ref, async (target, used) => {
        // Playwright still checks that the label, not something on top of it, receives the click.
        const covering = await coveringLabel(session, target, used)
        const clicked = covering?.label ?? target
        const options = { button, position: covering?.position }
        const through = covering ? ` through its label${covering.text && ` "${covering.text}"`}, which covers it` : ""
        return act(session, `Clicked ${element ?? ref}${through}`, () =>
          doubleClick ? clicked.dblclick(options) : clicked.click(options),
        )
      }),
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
  tool({
    name: "browser_click_at",
    description: "Click a point of the viewport, in CSS pixels from its top-left corner, such as one browser_locate returns. For what the snapshot does not show or a ref cannot operate, such as a canvas, a slider or a date picker; otherwise prefer browser_click.",
    schema: z.object({
      x: z.number().min(0).describe("Pixels from the left edge of the viewport"),
      y: z.number().min(0).describe("Pixels from the top edge of the viewport"),
      element,
    }),
    capability: "vision",
    run: async (session, { x, y, element }) => {
      // The mouse would dispatch a click outside the viewport without error, and it would reach nothing.
      const viewport = (await session.page()).viewportSize()
      if (viewport && (x >= viewport.width || y >= viewport.height)) {
        return { text: `x=${x}, y=${y} is outside the ${viewport.width}×${viewport.height} viewport, so nothing was clicked. Scroll the target into view and locate it again.`, isError: true }
      }
      return act(session, `Clicked ${element ? `${element} ` : ""}at x=${x}, y=${y}`, (page) => page.mouse.click(x, y))
    },
  }),
  tool({
    name: "browser_locate",
    description: "Find an element in a screenshot of the viewport and return the point to click it with browser_click_at. A grounding model reads the screenshot, so this also finds what the snapshot does not show, such as a canvas, a slider or a date picker. Describe the element by its visible text, look and position, e.g. \"the 15 in the October calendar\". Only the visible viewport is searched.",
    schema: z.object({ description: z.string().min(1).describe("The element to find, e.g. the Book button on the seat map") }),
    readOnly: true,
    capability: "vision",
    run: async (session, { description }, { groundingModel, groundingScale, groundingTimeoutMs = 30_000, signal }) => {
      if (!groundingModel) return { text: "browser_locate needs a grounding model (--grounding-model).", isError: true }
      // With the CSS scale one screenshot pixel is one CSS pixel at any device scale factor, as the mouse expects.
      const png = await (await session.page()).screenshot({ type: "png", scale: "css" })
      // A PNG stores its width and height at bytes 16 and 20 of its header.
      const size = { width: png.readUInt32BE(16), height: png.readUInt32BE(20) }
      // A grounding model that fails or hangs fails only this call, so the agent can go on with its other tools.
      const timeout = AbortSignal.timeout(groundingTimeoutMs)
      const stop = signal ? AbortSignal.any([signal, timeout]) : timeout
      const started = performance.now()
      let response: ModelResponse
      try {
        response = await interruptible(() => groundingModel.complete({
          system: groundingPrompt(size, groundingScale),
          messages: [{ role: "user", content: [{ type: "image", mimeType: "image/png", data: png.toString("base64") }, { type: "text", text: `Element: ${description}` }] }],
          tools: [],
          signal: stop,
        }), stop)
      } catch (error) {
        const reason = timeout.aborted ? `no reply within ${groundingTimeoutMs / 1000} s` : failureReason(error)
        return { text: `The grounding model request failed, so nothing was located: ${reason}`, isError: true }
      }
      const modelCall: ModelCall = { role: "grounding", text: response.text, model: response.model, durationMs: Math.round(performance.now() - started), usage: response.usage }
      const point = groundingPoint(response.text ?? "", size, groundingScale)
      if (!point) {
        const reply = (response.text ?? "").replace(/\s+/g, " ").trim()
        return {
          text: `No point inside the ${size.width}×${size.height} screenshot in the grounding model's reply. Describe the element another way, or scroll it into view first. The reply: ${JSON.stringify(reply.length > 200 ? `${reply.slice(0, 199)}…` : reply)}`,
          isError: true,
          modelCall,
        }
      }
      return {
        text: `Located ${description} at x=${point.x}, y=${point.y}. Pass these to browser_click_at.`,
        modelCall,
        // MCP clients get the point and the grounding call's usage here.
        structuredContent: { ...point, model: modelCall.model, durationMs: modelCall.durationMs, usage: modelCall.usage },
      }
    },
  }),
]

/**
 * The tools of these capabilities, set up with `options`. Without a grounding model browser_locate could only fail, so it
 * is left out, as browser_task is without an agent model. Pass the same list to the MCP server and the agent.
 */
export function selectTools(capabilities: Capability[] = ["core"], options: ToolOptions = {}): BrowserTool[] {
  return TOOLS
    .filter((candidate) => capabilities.includes(candidate.capability) && (options.groundingModel || candidate.name !== "browser_locate"))
    .map((candidate): BrowserTool => ({ ...candidate, run: (session, args, context) => candidate.run(session, args, { ...context, ...options }) }))
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

/**
 * Validate arguments, run the tool, and turn any failure into an error result the model can react to. `signal` stops a
 * model request the tool makes; browser operations are stopped by the caller, with `BrowserSession.cancelPending`.
 */
export async function callTool(
  tools: BrowserTool[],
  session: BrowserSession,
  name: string,
  args: unknown,
  signal?: AbortSignal,
): Promise<ToolResult> {
  const definition = tools.find((candidate) => candidate.name === name)
  if (!definition) return { text: `Unknown tool "${name}"`, isError: true }

  const parsed = definition.schema.safeParse(omitNullOptionals(definition.schema, args ?? {}))
  if (!parsed.success) {
    return { text: `Invalid arguments for ${name}: ${z.prettifyError(parsed.error)}`, isError: true }
  }
  try {
    return await definition.run(session, parsed.data, { signal })
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

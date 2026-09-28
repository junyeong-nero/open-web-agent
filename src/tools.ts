import { z } from "zod"
import type { Page } from "playwright"
import type { BrowserSession } from "./browser"
import type { ContentPart, ToolSpec } from "./model/types"

export interface ToolResult {
  /** What happened, always kept in the transcript. */
  text: string
  /** Page state after the tool ran. The agent keeps only the latest one in its context. */
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

/** Run a page action, wait for any navigation it caused, and return the fresh snapshot. */
async function act(session: BrowserSession, summary: string, action: (page: Page) => Promise<unknown>): Promise<ToolResult> {
  const page = await session.page()
  const navigated = page
    .waitForEvent("framenavigated", { predicate: (frame) => frame === page.mainFrame(), timeout: 750 })
    .then(() => true, () => false)
  await action(page)
  if (await navigated) await page.waitForLoadState("domcontentloaded", { timeout: 10_000 }).catch(() => {})
  return { text: summary, snapshot: await session.snapshot() }
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
      return { text: `Selected tab ${tabId}`, snapshot: await session.snapshot() }
    },
  }),
  tool({
    name: "browser_navigate",
    description: "Open a URL in the current tab.",
    schema: z.object({ url: z.string().describe("Absolute URL, e.g. https://example.com") }),
    run: (session, { url }) =>
      act(session, `Navigated to ${url}`, (page) => page.goto(url, { waitUntil: "domcontentloaded" })),
  }),
  tool({
    name: "browser_go_back",
    description: "Go back to the previous page in history.",
    schema: z.object({}),
    run: (session) => act(session, "Went back", (page) => page.goBack({ waitUntil: "domcontentloaded" })),
  }),
  tool({
    name: "browser_snapshot",
    description:
      "Capture the accessibility snapshot of the current page. Elements carry [ref=…] handles that the other tools accept.",
    schema: z.object({}),
    readOnly: true,
    run: async (session) => ({ text: "Captured page snapshot", snapshot: await session.snapshot() }),
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
    run: async (session, { ref, element, doubleClick, button }) => {
      const target = await session.locator(ref)
      return act(session, `Clicked ${element ?? ref}`, () =>
        doubleClick ? target.dblclick({ button }) : target.click({ button }),
      )
    },
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
    run: async (session, { ref, element, text, submit }) => {
      const target = await session.locator(ref)
      return act(session, `Typed into ${element ?? ref}${submit ? " and submitted" : ""}`, async () => {
        await target.fill(text)
        if (submit) await target.press("Enter")
      })
    },
  }),
  tool({
    name: "browser_select_option",
    description: "Select one or more options in a <select> element.",
    schema: z.object({ ref, element, values: z.array(z.string()).min(1).describe("Option values or labels") }),
    run: async (session, { ref, element, values }) => {
      const target = await session.locator(ref)
      return act(session, `Selected ${values.join(", ")} in ${element ?? ref}`, () => target.selectOption(values))
    },
  }),
  tool({
    name: "browser_hover",
    description: "Hover the mouse over an element.",
    schema: z.object({ ref, element }),
    run: async (session, { ref, element }) => {
      const target = await session.locator(ref)
      return act(session, `Hovered ${element ?? ref}`, () => target.hover())
    },
  }),
  tool({
    name: "browser_press_key",
    description: "Press a key or chord on the focused element, e.g. Enter, Escape, ArrowDown, Control+A.",
    schema: z.object({ key: z.string() }),
    run: (session, { key }) => act(session, `Pressed ${key}`, (page) => page.keyboard.press(key)),
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
      const target = ref ? await session.locator(ref) : undefined
      return act(session, `Scrolled ${direction} ${pixels}px`, async (page) => {
        if (target) await target.hover()
        await page.mouse.wheel(0, direction === "down" ? pixels : -pixels)
        await page.waitForTimeout(300)
      })
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
      return { text: "Wait finished", snapshot: await session.snapshot() }
    },
  }),
  tool({
    name: "browser_get_text",
    description: "Return the visible text of the page (or of one element). Use it to read content for the answer.",
    schema: z.object({ ref: ref.optional() }),
    readOnly: true,
    run: async (session, { ref }) => {
      const target = ref ? await session.locator(ref) : (await session.page()).locator("body")
      const text = (await target.innerText()).replace(/\n{3,}/g, "\n\n").trim()
      const max = session.options.maxSnapshotChars ?? 40_000
      return { pageText: true, text: text.length > max ? `${text.slice(0, max)}\n… [text truncated at ${max} chars]` : text || "(no text)" }
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

/** Validate arguments, run the tool, and turn any failure into an error result the model can react to. */
export async function callTool(
  tools: BrowserTool[],
  session: BrowserSession,
  name: string,
  args: unknown,
): Promise<ToolResult> {
  const definition = tools.find((candidate) => candidate.name === name)
  if (!definition) return { text: `Unknown tool "${name}"`, isError: true }

  const parsed = definition.schema.safeParse(args ?? {})
  if (!parsed.success) {
    return { text: `Invalid arguments for ${name}: ${z.prettifyError(parsed.error)}`, isError: true }
  }
  try {
    return await definition.run(session, parsed.data)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { text: `${name} failed: ${message.split("\n").slice(0, 3).join("\n")}\nTake a new browser_snapshot if the page may have changed.`, isError: true }
  }
}

export function resultContent(result: ToolResult): ContentPart[] {
  const parts: ContentPart[] = [{ type: "text", text: result.text }]
  if (result.snapshot) parts.push({ type: "text", text: result.snapshot })
  if (result.image) parts.push({ type: "image", ...result.image })
  return parts
}

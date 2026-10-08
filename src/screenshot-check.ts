import type { ModelRequest } from "./model/types"
import type { BrowserTool, ToolResult } from "./tools"

/** A screenshot check, the screenshot and the vision request together, is given up after this long. */
export const SCREENSHOT_CHECK_TIMEOUT_MS = 5_000

/** Three questions about one viewport screenshot, answered as strict JSON. */
export const SCREENSHOT_PROMPT = `You look at a screenshot of a web page for a browser agent that reads the page as text and cannot see it. Reply with only a JSON object of this form:
{"overlay":"none","loading":false,"blocked":false}
- "overlay": what covers the page in front of its content and would catch clicks meant for it: "cookie banner" (cookie or privacy consent), "sign-in popup" (asks to sign in or sign up), "popup" (any other dialog, popup or overlay), or "none". The page's own header, menu or footer is not an overlay.
- "loading": true if the page has not finished loading, for example it is blank or shows a spinner or grey placeholders instead of content.
- "blocked": true if the page is a bot check, a CAPTCHA or an access-denied page instead of the site's content.`

/** A Map, not an object, so that a reply such as "constructor" matches no overlay. */
const OVERLAYS = new Map([["cookie banner", "a cookie banner"], ["sign-in popup", "a sign-in popup"], ["popup", "a popup"]])

export interface ScreenshotVerdict {
  overlay: "cookie banner" | "sign-in popup" | "popup" | "none"
  loading: boolean
  blocked: boolean
}

/**
 * Page state that a snapshot does not show: something on top of the page caught an action, or an action left a tree
 * of fewer than five lines, as a page that is loading, blocked or covered does. Read-only tools never call for a check.
 */
export function needsScreenshotCheck(tool: BrowserTool | undefined, result: ToolResult): boolean {
  if (!tool || tool.readOnly) return false
  if (result.isError) return result.text.includes("intercepts pointer events")
  // The unavailable-state marker has no tree, so it never calls for a check.
  const start = result.snapshot?.indexOf("\nSnapshot:\n") ?? -1
  if (start < 0) return false
  return result.snapshot!.slice(start + "\nSnapshot:\n".length).split("\n").filter((line) => line.trim()).length < 5
}

/** One tool-less request with the screenshot. It does not say why the check runs, which would lead the answer. */
export function screenshotRequest(jpeg: Buffer): Omit<ModelRequest, "signal"> {
  return {
    system: SCREENSHOT_PROMPT,
    messages: [{ role: "user", content: [{ type: "image", mimeType: "image/jpeg", data: jpeg.toString("base64") }, { type: "text", text: "The current page." }] }],
    tools: [],
  }
}

/** The verdict in a vision model's reply, which may wrap the JSON in a code fence or a sentence; undefined when it holds none. */
export function parseScreenshotVerdict(reply = ""): ScreenshotVerdict | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(/\{[\s\S]*\}/.exec(reply)?.[0] ?? "")
  } catch {
    return undefined
  }
  const { overlay, loading, blocked } = parsed as Record<string, unknown>
  const covering = typeof overlay === "string" ? overlay.trim().toLowerCase() : ""
  if ((covering !== "none" && !OVERLAYS.has(covering)) || typeof loading !== "boolean" || typeof blocked !== "boolean") return undefined
  return { overlay: covering as ScreenshotVerdict["overlay"], loading, blocked }
}

/**
 * The transcript line for a verdict, e.g. `Screenshot check: a cookie banner covers the page.`, or undefined when the
 * check found nothing. It is built from fixed phrases only, so no text from the page reaches the transcript through it.
 */
export function screenshotNote({ overlay, loading, blocked }: ScreenshotVerdict): string | undefined {
  const findings: string[] = []
  // A block page ends the visit, so whatever spins or pops up on it does not matter.
  if (blocked) findings.push("the page is a bot check or an access-denied page")
  else {
    if (overlay !== "none") findings.push(`${OVERLAYS.get(overlay)} covers the page`)
    if (loading) findings.push("the page is still loading")
  }
  return findings.length ? `Screenshot check: ${findings.join("; ")}.` : undefined
}

import type { ModelRequest } from "./model/types"
import type { BrowserTool, ToolResult } from "./tools"

/** A screenshot check, the screenshot and the vision request together, is abandoned after this long. */
export const SCREENSHOT_CHECK_TIMEOUT_MS = 5_000

const PROMPT = `You look at a screenshot of a web page for a browser agent that reads the page as text and cannot see it. Reply with only a JSON object of this form:
{"overlay":"none","loading":false,"blocked":false}
- "overlay": what covers the page in front of its content and would catch clicks meant for it: "cookie banner" (cookie or privacy consent), "sign-in popup" (asks to sign in or sign up), "popup" (any other dialog, popup or overlay), or "none". The page's own header, menu or footer is not an overlay.
- "loading": true if the page has not finished loading, for example it is blank or shows a spinner or grey placeholders instead of content.
- "blocked": true if the page is a bot check, a CAPTCHA or an access-denied page instead of the site's content.`

const OVERLAYS = new Map([["cookie banner", "a cookie banner"], ["sign-in popup", "a sign-in popup"], ["popup", "a popup"]])

/**
 * Page state that a snapshot does not show: an action that something on top intercepted, or an action that left a
 * tree of fewer than five lines, as a page that is loading, blocked or hidden behind an overlay does.
 */
export function needsScreenshotCheck(tool: BrowserTool | undefined, result: ToolResult): boolean {
  if (!tool || tool.readOnly) return false
  if (result.isError) return result.text.includes("intercepts pointer events")
  const tree = result.snapshot?.split("\nSnapshot:\n")[1]
  return tree !== undefined && tree.split("\n").filter((line) => line.trim()).length < 5
}

/** Ask about one viewport screenshot, without tools. */
export function screenshotRequest(jpeg: Buffer, signal: AbortSignal): ModelRequest {
  return {
    system: PROMPT,
    messages: [{ role: "user", content: [{ type: "image", mimeType: "image/jpeg", data: jpeg.toString("base64") }, { type: "text", text: "The current page." }] }],
    tools: [],
    signal,
  }
}

/**
 * The transcript line for a verdict, e.g. `Screenshot check: a cookie banner covers the page.` It is written here
 * from fixed phrases, so no page text reaches the transcript through it. A verdict that finds nothing, or a reply
 * that is not a verdict, gives no line.
 */
export function screenshotNote(reply: string | undefined): string | undefined {
  let verdict: unknown
  try {
    // Models often wrap JSON in a code fence or a sentence; the object itself must still be exact.
    verdict = JSON.parse(/\{[\s\S]*\}/.exec(reply ?? "")?.[0] ?? "")
  } catch {
    return undefined
  }
  const { overlay, loading, blocked } = verdict as Record<string, unknown>
  const covering = typeof overlay === "string" ? overlay.trim().toLowerCase() : ""
  if ((covering !== "none" && !OVERLAYS.has(covering)) || typeof loading !== "boolean" || typeof blocked !== "boolean") return undefined
  // A block page ends the visit, so whatever spins or pops up on it does not matter.
  const findings = blocked
    ? ["the page is a bot check or an access-denied page"]
    : [OVERLAYS.has(covering) && `${OVERLAYS.get(covering)} covers the page`, loading && "the page is still loading"].filter(Boolean)
  return findings.length ? `Screenshot check: ${findings.join("; ")}.` : undefined
}

/**
 * Shorter link targets in snapshots (#202). Playwright's AI snapshot gives each link with an href a `- /url: …` line,
 * and these lines are about a sixth of a snapshot's characters. Models still navigate to these URLs, so a URL changes
 * only into a form that opens the same page:
 * - A search engine's click-tracking link becomes the target that it holds.
 * - Well-known tracking parameters, such as utm_* and ad click IDs, leave the query.
 * - A link on the page's own origin keeps only its path, query and fragment, which resolve against the page URL.
 * Everything else stays as the page wrote it, long queries included. Any parameter that is not a tracking one may be
 * one the page needs, such as a search filter, an OAuth state or a signed token, so no cut could promise the same page.
 */

/** Parameters that only carry ad-click, analytics and email-campaign IDs; most are on Firefox's query-stripping list. */
const TRACKING = /^(?:utm_\w+|gclid|gclsrc|dclid|gbraid|wbraid|fbclid|msclkid|twclid|ttclid|li_fat_id|igshid|yclid|ysclid|srsltid|_gl|_openstat|mc_cid|mc_eid|_hsenc|_hsmi|__hssc|__hstc|__hsfp|hsctatracking|mkt_tok|oly_anon_id|oly_enc_id|vero_id|vero_conv|wickedid)$/i

/** `tree` with the `- /url: …` line of each link compacted for the page at `pageUrl`; every other line stays as it was. */
export function compactUrls(tree: string, pageUrl?: string): string {
  const page = pageUrl === undefined ? undefined : webUrl(pageUrl)
  // A quoted value is left alone: Playwright quotes the rare URL that YAML would misread, such as "#top".
  return tree.replace(/^( *- \/url: )([^"\n].*)$/gm, (line, key: string, value: string) => {
    const short = compactUrl(value, page)
    return short === value || needsQuotes(short) ? line : key + short
  })
}

function compactUrl(value: string, page?: URL): string {
  const link = webUrl(value, page)
  if (!link) return value
  const text = withoutTracking(redirectTarget(link) ?? value)
  const origin = page && /^(?:https?:)?\/\/[^/?#\\]*/i.exec(text)?.[0]
  if (!origin) return text
  const rest = text.slice(origin.length)
  const path = rest.startsWith("/") ? rest : `/${rest}`
  // The path resolves against the page URL, so it must lead to the same URL from there.
  return webUrl(path, page)?.href === webUrl(text, page)?.href ? path : text
}

/** `text` without its tracking parameters; the other parameters keep their order and encoding. */
function withoutTracking(text: string): string {
  const hash = text.indexOf("#")
  const end = hash < 0 ? text.length : hash
  const start = text.indexOf("?")
  if (start < 0 || start > end) return text
  const params = text.slice(start + 1, end).split("&")
  if (!params.some(tracking)) return text
  const kept = params.filter((param) => param && !tracking(param))
  const path = text.slice(0, start)
  // A link that is only a query keeps its "?": an empty link would keep the page's own query.
  return path + (kept.length || !path ? "?" : "") + kept.join("&") + text.slice(end)
}

function tracking(param: string): boolean {
  try {
    return TRACKING.test(decodeURIComponent(param.split("=")[0]!.replaceAll("+", " ")))
  } catch {
    return false
  }
}

/**
 * The page that a search engine's click-tracking link opens, when the link holds it: the url or q parameter of Google's
 * /url, or the u parameter of Bing's /ck/a, which is "a1" and the target in base64url. Bing links its own pages by path.
 */
function redirectTarget(link: URL): string | undefined {
  if (/(?:^|\.)google\.(?:com?\.)?[a-z]{2,3}$/.test(link.hostname) && link.pathname === "/url") {
    return [link.searchParams.get("url"), link.searchParams.get("q")].find((target) => /^https?:\/\//i.test(target ?? "") && webUrl(target!)) ?? undefined
  }
  const encoded = /^a1([\w-]+)$/.exec(link.searchParams.get("u") ?? "")?.[1]
  if (!encoded || !/(?:^|\.)bing\.com$/.test(link.hostname) || link.pathname !== "/ck/a") return undefined
  try {
    const target = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(encoded, "base64url"))
    const url = /^(?:https?:\/)?\//i.test(target) ? webUrl(target, link) : undefined
    // Keep the target as written, unless it is a path on Bing or has spaces that would end the URL in the snapshot.
    return url && (target.startsWith("/") || /[\s\x00-\x1f]/.test(target) ? url.href : target)
  } catch {
    return undefined
  }
}

function webUrl(text: string, base?: URL | string): URL | undefined {
  try {
    const url = new URL(text, base)
    return url.protocol === "http:" || url.protocol === "https:" ? url : undefined
  } catch {
    return undefined
  }
}

/** Whether Playwright would quote `text` as a YAML value (its yamlStringNeedsQuotes). */
function needsQuotes(text: string): boolean {
  return !text || /^[\s\-&*\],?!>|@"'#%[]|\s$|[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]|[\n:](?:\s|$)|\s#|[\n\r{}`]/.test(text)
    || !Number.isNaN(Number(text)) || /^(?:y|n|yes|no|true|false|on|off|null)$/i.test(text)
}

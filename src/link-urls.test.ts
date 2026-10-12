import { describe, expect, it } from "bun:test"
import { BrowserSession } from "./browser"
import { compactUrls } from "./link-urls"

const page = "https://shop.example/search?q=lamp&page=2"
/** The link target a snapshot shows for `url` on `pageUrl`. */
const compact = (url: string, pageUrl: string | undefined = page) => compactUrls(`- /url: ${url}`, pageUrl).slice("- /url: ".length)
const base64url = (text: string) => Buffer.from(text).toString("base64url")

describe("same origin", () => {
  it("keeps only the path, query and fragment of a link on the page's origin", () => {
    expect(compact("https://shop.example/items/42?color=red#reviews")).toBe("/items/42?color=red#reviews")
    expect(compact("HTTPS://SHOP.EXAMPLE:443/Items")).toBe("/Items")
    expect(compact("//shop.example/help")).toBe("/help")
    // Without a path the link still needs one, or it would resolve against the page's own path.
    expect(compact("https://shop.example")).toBe("/")
    expect(compact("https://shop.example?ref=nav")).toBe("/?ref=nav")
    expect(compact("https://shop.example#top")).toBe("/#top")
  })

  it("keeps the full URL when its path would resolve to another URL", () => {
    for (const url of [
      "https://cdn.shop.example/items/42",
      "http://shop.example/items/42",
      "https://shop.example:8443/items/42",
      "https://user:secret@shop.example/items/42",
      // As a path, "//evil.example/x" would name another host.
      "https://shop.example//evil.example/x",
    ]) expect(compact(url)).toBe(url)
  })

  it("keeps characters as the page wrote them", () => {
    expect(compact("https://ko.wikipedia.org/wiki/서울", "https://ko.wikipedia.org/wiki/부산")).toBe("/wiki/서울")
  })
})

describe("tracking parameters", () => {
  it("drops well-known tracking parameters and keeps the others in order and encoding", () => {
    expect(compact("https://news.example/story?utm_source=home&id=7&UTM_MEDIUM=email&q=a%20b+c&gclid=x1&fbclid=x2#comments"))
      .toBe("https://news.example/story?id=7&q=a%20b+c#comments")
    expect(compact("https://news.example/a?msclkid=1&mc_eid=2&_hsenc=3&srsltid=4&utm%5Fcampaign=5&ref=home")).toBe("https://news.example/a?ref=home")
    expect(compact("https://news.example/a?utm_source=home&utm_medium=email")).toBe("https://news.example/a")
  })

  it("keeps parameters that only look like tracking ones, and the fragment", () => {
    const urls = [
      "https://forms.example/apply?prefill_utm_source=footer&utm=1&ref=nav&cid=9",
      "https://app.example/#/route?utm_source=home",
    ]
    for (const url of urls) expect(compact(url)).toBe(url)
  })
})

describe("search engine redirects", () => {
  it("opens Google's /url target directly", () => {
    expect(compact("https://www.google.com/url?q=https://docs.example/guide%3Fv%3D2&sa=U&ved=0ah&usg=AOv")).toBe("https://docs.example/guide?v=2")
    expect(compact("https://www.google.co.kr/url?sa=t&url=https://docs.example/a&usg=AOv")).toBe("https://docs.example/a")
    // A relative /url link on a Google page, whose target carries a tracking parameter.
    expect(compact("/url?url=https://docs.example/a?srsltid=AfmB&rct=j&q=", "https://www.google.com/search?q=docs")).toBe("https://docs.example/a")
    expect(compact("https://www.google.com/url?q=https://www.google.com/maps&sa=U", "https://www.google.com/search?q=maps")).toBe("/maps")
  })

  it("opens Bing's /ck/a target, which is base64url after a1", () => {
    const target = "https://docs.example/a?utm_campaign=bing&page=3"
    expect(compact(`https://www.bing.com/ck/a?!&&p=8f2&ptn=3&ver=2&hsh=4&fclid=1-2&u=a1${base64url(target)}&ntb=1`)).toBe("https://docs.example/a?page=3")
    // Bing links its own pages by path.
    const images = `https://www.bing.com/ck/a?!&&p=8f2&u=a1${base64url("/images/search?q=lamp&FORM=HDRSC2")}&ntb=1`
    expect(compact(images, "https://www.bing.com/search?q=lamp")).toBe("/images/search?q=lamp&FORM=HDRSC2")
    expect(compact(images)).toBe("https://www.bing.com/images/search?q=lamp&FORM=HDRSC2")
  })

  it("keeps a redirect whose target is not in the link, and look-alike hosts", () => {
    for (const url of [
      "https://www.google.com/url?q=lamp",
      "https://www.google.com/goto?url=CAESqwEB6zsw",
      "https://www.google.evil.example/url?q=https://docs.example/a",
      "https://example.com/url?q=https://docs.example/a",
      "https://www.bing.com/ck/a?!&&p=8f2&u=b1aHR0cHM6Ly9kb2NzLmV4YW1wbGU",
      `https://www.bing.com/ck/a?!&&p=8f2&u=a1${base64url("javascript:alert(1)")}`,
      "https://www.bing.com/ck/a?!&&p=8f2&u=a1***",
      `https://bing.com.evil.example/ck/a?u=a1${base64url("https://docs.example/a")}`,
    ]) expect(compact(url)).toBe(url)
  })
})

describe("long queries", () => {
  it("keeps a long query whole, apart from its tracking parameters", () => {
    const search = "https://hotels.example/searchresults.html?checkin=2026-12-20&checkout=2026-12-23&dest_id=20090&dest_type=region&group_adults=3&no_rooms=2&group_children=0&sid=8f2c0d1e9a7b6c5d4e3f2a1b0c9d8e7f"
    expect(compact(search)).toBe(search)
    expect(compact(`${search}&utm_source=mail&utm_campaign=winter`)).toBe(search)
    const signIn = `https://account.example/oauth2?client_id=vO1K&redirect_uri=https%3A%2F%2Fsecure.example%2Flogin&response_type=code&state=${"UsAB".repeat(60)}`
    expect(compact(signIn)).toBe(signIn)
  })
})

describe("relative and other links", () => {
  it("leaves relative URLs and links that are not web pages as they are", () => {
    for (const url of ["/items/42", "items/42", "../items/42?color=red", "javascript:void(0)", "mailto:help@shop.example", "tel:+15550100"]) {
      expect(compact(url)).toBe(url)
    }
    const tree = ['- link "Top" [ref=e1]:', '  - /url: "#top"', '- link "Next" [ref=e2]:', '  - /url: "?page=3"'].join("\n")
    expect(compactUrls(tree, page)).toBe(tree)
  })

  it("drops tracking parameters from a relative URL without resolving it", () => {
    expect(compact("/items/42?utm_source=home&color=red")).toBe("/items/42?color=red")
    expect(compact("../items/42?fbclid=x")).toBe("../items/42")
  })
})

describe("snapshot trees", () => {
  const tree = [
    "- generic [ref=e1]:",
    '  - link "Lamp" [ref=e2] [cursor=pointer]:',
    "    - /url: https://shop.example/items/42?utm_source=search",
    '    - img "Lamp" [ref=e3]',
    "  - text: https://shop.example/items/42?utm_source=search",
    '  - link "Docs" [ref=e4]:',
    "    - /url: https://docs.example/a",
    '  - textbox "Search" [ref=e5]:',
    "    - /placeholder: https://shop.example/search",
  ].join("\n")

  it("changes only /url: lines", () => {
    const shown = compactUrls(tree, page).split("\n")
    expect(shown).toEqual(tree.split("\n").map((line) => line.replace("- /url: https://shop.example/items/42?utm_source=search", "- /url: /items/42")))
  })

  it("shortens same-origin links only when the page URL is a web URL", () => {
    expect(compactUrls(tree)).toBe(tree.replace("- /url: https://shop.example/items/42?utm_source=search", "- /url: https://shop.example/items/42"))
    expect(compactUrls(tree, "about:blank")).toBe(compactUrls(tree))
  })

  it("keeps a line whose shorter URL YAML would misread", () => {
    // Playwright quotes a value with braces, so the target would need quotes where the link needed none.
    const line = `- /url: https://www.bing.com/ck/a?!&&p=8f2&u=a1${base64url("https://docs.example/a?q={x}")}`
    expect(compactUrls(line, page)).toBe(line)
  })

  it("compacts before the cut, so the budget holds more of the page", () => {
    const links = Array.from({ length: 3 }, (_, index) => `- link "Item ${index}" [ref=e${index + 1}]:\n  - /url: https://shop.example/items/${index}?utm_source=home`).join("\n")
    const compacted = links.replaceAll("https://shop.example", "").replaceAll("?utm_source=home", "")
    const session = new BrowserSession({ maxSnapshotChars: compacted.length })
    expect(links.length).toBeGreaterThan(compacted.length)
    expect(session.shown(links, page)).toBe(compacted)
    expect(new BrowserSession({ maxSnapshotChars: compacted.length - 1 }).shown(links, page)).toEndWith(`\n… [snapshot truncated at ${compacted.length - 1} chars]`)
  })
})

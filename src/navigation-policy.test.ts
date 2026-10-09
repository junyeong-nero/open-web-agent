import { expect, it } from "bun:test"
import { SYSTEM_PROMPT } from "./agent"
import { downloadMessage, retryAfterSeconds } from "./tools"

it("bounds Retry-After seconds and HTTP dates, with a two-second fallback", () => {
  const now = Date.parse("Fri, 09 Oct 2026 12:00:00 GMT")
  expect(retryAfterSeconds("1", now)).toBe(1)
  expect(retryAfterSeconds(" 0 ", now)).toBe(0)
  expect(retryAfterSeconds("Fri, 09 Oct 2026 12:00:05 GMT", now)).toBe(5)
  expect(retryAfterSeconds("Fri, 09 Oct 2026 11:59:00 GMT", now)).toBe(0)
  for (const header of [undefined, null, "", "invalid", "-1", "1.5"]) expect(retryAfterSeconds(header, now)).toBe(2)
  expect(retryAfterSeconds("30", now)).toBe(10)
  expect(retryAfterSeconds("Fri, 09 Oct 2026 12:01:00 GMT", now)).toBe(10)
})

const message = (type: string, name: string) => downloadMessage({
  response: { headers: () => ({ "content-type": type }) }, download: { suggestedFilename: () => name },
})

it("preserves document download advice for recognized types and octet-stream filenames", () => {
  for (const [type, extension] of [
    ["application/pdf", "pdf"], ["application/msword", "doc"],
    ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", "docx"],
    ["application/vnd.ms-excel", "xls"], ["application/vnd.ms-powerpoint", "ppt"],
    ["application/vnd.oasis.opendocument.text", "odt"], ["text/csv", "csv"],
    ["text/plain", "txt"], ["application/json", "json"], ["application/xml", "xml"],
    ["text/xml", "xml"], ["application/zip", "zip"], ["application/x-7z-compressed", "7z"],
    ["image/png", "png"], ["audio/mpeg", "mp3"], ["video/mp4", "mp4"],
  ]) {
    for (const text of [message(type!, "download"), message("application/octet-stream", `FILE.${extension!.toUpperCase()}`)]) {
      expect(text).toContain("Opening the same URL again gives the same result.")
      expect(text).not.toContain("block under the rules")
    }
  }
  expect(message("application/pdf", "paper.pdf")).toBe("The server sent a file (content-type `application/pdf`, filename `paper.pdf`) instead of a web page; the browser cannot display it. Opening the same URL again gives the same result. For a PDF, look for an HTML version of the same document, such as its abstract or landing page.")
})

it("treats unknown file responses as a site block and retains their details", () => {
  for (const type of ["application/blank", "application/x-unknown", "application/octet-stream"]) {
    const text = message(type, "response")
    expect(text).toContain(`non-document file (content-type \`${type}\`, filename \`response\`) instead of a page`)
    expect(text).toContain("other URLs on the same site will likely do the same.")
    expect(text).toContain("This counts as a block under the rules; use another site.")
  }
})

it("blocks persistent 429 responses and non-document files, but not a bare 429", () => {
  const rule = SYSTEM_PROMPT.split("\n").find((line) => line.includes("do not retry that site"))!
  expect(rule).toContain("HTTP 401, 402 or 403")
  expect(rule.match(/429/g)).toHaveLength(1)
  expect(rule).toContain("a result says HTTP 429 persisted after the automatic wait and reload")
  expect(rule).toContain("navigation returns a non-document file instead of a page")
})

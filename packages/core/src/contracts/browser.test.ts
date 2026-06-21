import { describe, expect, it } from "bun:test"
import { BrowserActionSchema, BrowserToolCallSchema, isAllowedBrowserNavigationUrl } from "./browser"

describe("BrowserActionSchema", () => {
  it("accepts a browser action with nested tool calls", () => {
    const parsed = BrowserActionSchema.parse({
      id: "action_1",
      kind: "inspect_page_title",
      reason: "Need to open the page before reading title.",
      requiresApproval: false,
      toolCalls: [{ id: "tool_1", type: "navigate", url: "https://example.com" }],
    })

    expect(parsed.toolCalls[0]?.type).toBe("navigate")
  })

  it("rejects a browser action with no tool calls", () => {
    expect(() =>
      BrowserActionSchema.parse({
        id: "action_1",
        kind: "empty",
        reason: null,
        requiresApproval: false,
        toolCalls: [],
      }),
    ).toThrow()
  })
})

describe("BrowserToolCallSchema", () => {
  it("accepts public HTTP and HTTPS navigation URLs", () => {
    for (const url of ["https://example.com", "http://example.com/search?q=open-web-agent"]) {
      expect(BrowserToolCallSchema.safeParse({ id: "tool_1", type: "navigate", url }).success).toBe(true)
    }
  })

  it("rejects malformed navigation URLs without throwing", () => {
    expect(BrowserToolCallSchema.safeParse({ id: "tool_1", type: "navigate", url: "not a url" }).success).toBe(
      false,
    )
  })

  it("rejects navigation URLs with local or scriptable schemes", () => {
    for (const url of [
      "file:///etc/hosts",
      "data:text/plain,hello",
      "javascript:alert(1)",
      "ftp://example.com/file",
    ]) {
      expect(BrowserToolCallSchema.safeParse({ id: "tool_1", type: "navigate", url }).success).toBe(false)
    }
  })

  it("classifies local and private network navigation URLs as unsafe by default", () => {
    for (const url of [
      "http://localhost:3000",
      "http://app.localhost",
      "http://internal",
      "http://metadata.google.internal",
      "http://127.0.0.1",
      "http://10.0.0.1",
      "http://172.16.0.1",
      "http://172.31.255.255",
      "http://192.168.1.1",
      "http://169.254.169.254",
      "http://[::1]",
      "http://[fc00::1]",
      "http://[fe80::1]",
      "http://[::ffff:127.0.0.1]",
    ]) {
      expect(isAllowedBrowserNavigationUrl(url)).toBe(false)
    }
  })
})

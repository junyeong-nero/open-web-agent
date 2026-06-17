import { describe, expect, it } from "bun:test"
import { BrowserActionSchema } from "./browser"

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

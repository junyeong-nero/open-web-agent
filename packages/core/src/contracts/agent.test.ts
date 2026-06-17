import { describe, expect, it } from "bun:test"
import { AgentDecisionSchema } from "./agent"

describe("AgentDecisionSchema", () => {
  it("accepts browser_actions decisions", () => {
    const parsed = AgentDecisionSchema.parse({
      type: "browser_actions",
      thought: "Open the target page.",
      actions: [
        {
          id: "action_1",
          kind: "inspect_page_title",
          reason: null,
          requiresApproval: false,
          toolCalls: [{ id: "tool_1", type: "navigate", url: "https://example.com" }],
        },
      ],
    })

    expect(parsed.type).toBe("browser_actions")
  })

  it("does not accept top-level tool_calls decisions", () => {
    expect(() =>
      AgentDecisionSchema.parse({
        type: "tool_calls",
        thought: null,
        toolCalls: [],
      }),
    ).toThrow()
  })
})

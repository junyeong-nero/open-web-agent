import { describe, expect, it } from "bun:test"
import { BrowserToolValidationError } from "@open-web-agent/core"
import {
  listPlaywrightBrowserTools,
  parsePlaywrightModelToolCall,
  validatePlaywrightBrowserToolCall,
} from "./playwright-tool-catalog"

describe("Playwright browser tool catalog", () => {
  it("exposes the ten existing tools as core model tools", () => {
    const tools = listPlaywrightBrowserTools(["core"])

    expect(tools.map((tool) => tool.name)).toEqual([
      "browser_navigate",
      "browser_click",
      "browser_type",
      "browser_scroll",
      "browser_wait_for",
      "browser_press_key",
      "browser_take_screenshot",
      "browser_extract_text",
      "browser_navigate_back",
      "browser_navigate_forward",
    ])
    expect(tools.every((tool) => tool.capability === "core")).toBe(true)
    expect(tools.find((tool) => tool.name === "browser_navigate")?.inputSchema).toMatchObject({
      type: "object",
      required: ["url"],
      additionalProperties: false,
    })
  })

  it("maps a native model call to the closed browser contract", () => {
    expect(
      parsePlaywrightModelToolCall(
        {
          id: "call_1",
          name: "browser_navigate",
          arguments: { url: "https://example.com" },
        },
        ["core"],
      ),
    ).toEqual({
      id: "call_1",
      type: "navigate",
      url: "https://example.com",
    })
  })

  it("rejects unknown names and malformed arguments with stable codes", () => {
    expect(() =>
      parsePlaywrightModelToolCall({ id: "call_1", name: "browser_unknown", arguments: {} }, ["core"]),
    ).toThrow(BrowserToolValidationError)

    try {
      parsePlaywrightModelToolCall({ id: "call_2", name: "browser_navigate", arguments: {} }, ["core"])
      throw new Error("expected validation to fail")
    } catch (error) {
      expect(error).toMatchObject({ code: "invalid_tool_arguments" })
    }
  })

  it("revalidates legacy internal calls against the active catalog", () => {
    expect(
      validatePlaywrightBrowserToolCall(
        { id: "legacy_1", type: "scroll", deltaX: 0, deltaY: 500 },
        ["core"],
      ),
    ).toMatchObject({ id: "legacy_1", type: "scroll", deltaY: 500 })
  })
})

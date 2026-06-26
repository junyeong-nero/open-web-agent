import { describe, expect, it } from "bun:test"
import { BrowserToolValidationError, assertSupportedBrowserCapabilities } from "./tool-validation"

describe("browser tool validation", () => {
  it("rejects a configured capability unsupported by an adapter", () => {
    expect(() => assertSupportedBrowserCapabilities(["core", "storage"], ["core"])).toThrow(
      "Unsupported browser capability: storage",
    )
  })

  it("serializes stable validation error output", () => {
    const error = new BrowserToolValidationError("invalid_tool_arguments", "browser_click requires target", [
      { path: ["target"], code: "invalid_type", message: "Required" },
    ])

    expect(error.toModelOutput()).toEqual({
      code: "invalid_tool_arguments",
      message: "browser_click requires target",
      issues: [{ path: ["target"], code: "invalid_type", message: "Required" }],
    })
  })
})

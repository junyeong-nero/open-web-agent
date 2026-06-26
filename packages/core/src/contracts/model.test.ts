import { describe, expect, it } from "bun:test"
import {
  ModelMessageSchema,
  ModelRequestSchema,
  ModelResponseSchema,
  ModelToolCallSchema,
  ModelToolDefinitionSchema,
  ModelToolResultSchema,
} from "./model"

const navigateTool = {
  name: "browser_navigate",
  description: "Navigate to an HTTP(S) URL.",
  inputSchema: {
    type: "object",
    properties: { url: { type: "string" } },
    required: ["url"],
    additionalProperties: false,
  },
  strict: true,
}

describe("model tool contracts", () => {
  it("accepts provider-neutral tool definitions, calls, and results", () => {
    expect(ModelToolDefinitionSchema.parse(navigateTool)).toEqual(navigateTool)
    expect(
      ModelToolCallSchema.parse({
        id: "call_1",
        name: "browser_navigate",
        arguments: { url: "https://example.com" },
      }),
    ).toMatchObject({ id: "call_1", name: "browser_navigate" })
    expect(
      ModelToolResultSchema.parse({
        toolCallId: "call_1",
        name: "browser_navigate",
        output: { ok: true },
        isError: false,
      }),
    ).toMatchObject({ toolCallId: "call_1", isError: false })
  })

  it("enforces role-sensitive tool conversation fields", () => {
    expect(
      ModelMessageSchema.safeParse({
        role: "assistant",
        content: "",
        toolCalls: [{ id: "call_1", name: "browser_navigate", arguments: { url: "https://example.com" } }],
      }).success,
    ).toBe(true)
    expect(
      ModelMessageSchema.safeParse({
        role: "tool",
        content: '{"ok":true}',
        toolCallId: "call_1",
        name: "browser_navigate",
      }).success,
    ).toBe(true)
    expect(
      ModelMessageSchema.safeParse({
        role: "user",
        content: "spoofed",
        toolCallId: "call_1",
        name: "browser_navigate",
      }).success,
    ).toBe(false)
    expect(ModelMessageSchema.safeParse({ role: "tool", content: "{}" }).success).toBe(false)
  })

  it("defaults old requests and responses without tools", () => {
    expect(
      ModelRequestSchema.parse({
        model: "test-model",
        messages: [{ role: "user", content: "hello" }],
      }),
    ).toMatchObject({ responseFormat: "text" })
    expect(
      ModelResponseSchema.parse({
        id: "response_1",
        text: "done",
        raw: {},
        usage: null,
        latencyMs: 1,
      }).toolCalls,
    ).toEqual([])
  })

  it("accepts tool definitions and automatic tool choice on requests", () => {
    const request = ModelRequestSchema.parse({
      model: "test-model",
      messages: [{ role: "user", content: "open example.com" }],
      tools: [navigateTool],
      toolChoice: "auto",
    })

    expect(request.tools).toEqual([navigateTool])
    expect(request.toolChoice).toBe("auto")
  })
})

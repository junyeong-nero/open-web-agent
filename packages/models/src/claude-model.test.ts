import { describe, expect, it } from "bun:test"
import type { RuntimeContext } from "@open-web-agent/core"
import { ClaudeModel } from "./claude-model"

describe("ClaudeModel", () => {
  it("uses the Claude OpenAI-compatible chat completions endpoint", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const abort = new AbortController()
    const model = new ClaudeModel({
      apiKey: "anthropic-key",
      defaultModel: "claude-test",
      fetch: async (url, init) => {
        calls.push({ url: String(url), init: init ?? {} })
        return Response.json({ id: "res_1", choices: [{ message: { content: "ok" } }], usage: null })
      },
    })

    const response = await model.complete(
      {
        model: "claude-test",
        messages: [{ role: "user", content: "hi" }],
        tools: [
          {
            name: "browser_navigate",
            description: "Navigate",
            inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
          },
        ],
        toolChoice: "auto",
        temperature: 0,
        responseFormat: "text",
      },
      { abortSignal: abort.signal } as RuntimeContext,
    )

    expect(model.id).toBe("claude")
    expect(model.provider).toBe("claude")
    expect(calls[0]?.url).toBe("https://api.anthropic.com/v1/chat/completions")
    expect(calls[0]?.init.signal).toBe(abort.signal)
    expect(calls[0]?.init.headers).toMatchObject({
      authorization: "Bearer anthropic-key",
    })
    expect(JSON.parse(String(calls[0]?.init.body))).toMatchObject({
      tools: [{ type: "function", function: { name: "browser_navigate" } }],
      tool_choice: "auto",
    })
    expect(response.text).toBe("ok")
  })
})

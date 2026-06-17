import { describe, expect, it } from "bun:test"
import { ClaudeModel } from "./claude-model"

describe("ClaudeModel", () => {
  it("uses the Claude OpenAI-compatible chat completions endpoint", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const model = new ClaudeModel({
      apiKey: "anthropic-key",
      defaultModel: "claude-test",
      fetch: async (url, init) => {
        calls.push({ url: String(url), init: init ?? {} })
        return Response.json({ id: "res_1", choices: [{ message: { content: "ok" } }], usage: null })
      },
    })

    const response = await model.complete(
      { model: "claude-test", messages: [{ role: "user", content: "hi" }], temperature: 0, responseFormat: "text" },
      {} as never,
    )

    expect(model.id).toBe("claude")
    expect(model.provider).toBe("claude")
    expect(calls[0]?.url).toBe("https://api.anthropic.com/v1/chat/completions")
    expect(calls[0]?.init.headers).toMatchObject({
      authorization: "Bearer anthropic-key",
    })
    expect(response.text).toBe("ok")
  })
})

import { describe, expect, it } from "bun:test"
import { OpenRouterModel } from "./openrouter-model"

describe("OpenRouterModel", () => {
  it("uses the OpenRouter chat completions endpoint with app headers", async () => {
    const calls: RequestInit[] = []
    const model = new OpenRouterModel({
      apiKey: "openrouter-key",
      defaultModel: "openai/gpt-test",
      fetch: async (_url, init) => {
        calls.push(init ?? {})
        return Response.json({ id: "res_1", choices: [{ message: { content: "ok" } }], usage: null })
      },
    })

    await model.complete(
      { model: "openai/gpt-test", messages: [{ role: "user", content: "hi" }], temperature: 0, responseFormat: "text" },
      {} as never,
    )

    expect(model.provider).toBe("openrouter")
    expect(calls[0]?.headers).toMatchObject({
      authorization: "Bearer openrouter-key",
      "http-referer": "https://github.com/open-web-agent/open-web-agent",
      "x-title": "Open Web Agent",
    })
  })
})

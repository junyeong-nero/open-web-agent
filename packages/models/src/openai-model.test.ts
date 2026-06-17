import { describe, expect, it } from "bun:test"
import { OpenAIModel } from "./openai-model"

describe("OpenAIModel", () => {
  it("uses the OpenAI chat completions endpoint", async () => {
    const urls: string[] = []
    const model = new OpenAIModel({
      apiKey: "openai-key",
      defaultModel: "gpt-test",
      fetch: async (url) => {
        urls.push(String(url))
        return Response.json({ id: "res_1", choices: [{ message: { content: "ok" } }], usage: null })
      },
    })

    const response = await model.complete(
      { model: "gpt-test", messages: [{ role: "user", content: "hi" }], temperature: 0, responseFormat: "text" },
      {} as never,
    )

    expect(model.id).toBe("openai")
    expect(urls[0]).toBe("https://api.openai.com/v1/chat/completions")
    expect(response.text).toBe("ok")
  })
})

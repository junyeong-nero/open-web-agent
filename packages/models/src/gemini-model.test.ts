import { describe, expect, it } from "bun:test"
import type { RuntimeContext } from "@open-web-agent/core"
import { GeminiModel } from "./gemini-model"

describe("GeminiModel", () => {
  it("uses the Gemini OpenAI-compatible chat completions endpoint", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const abort = new AbortController()
    const model = new GeminiModel({
      apiKey: "gemini-key",
      defaultModel: "gemini-test",
      fetch: async (url, init) => {
        calls.push({ url: String(url), init: init ?? {} })
        return Response.json({ id: "res_1", choices: [{ message: { content: "ok" } }], usage: null })
      },
    })

    const response = await model.complete(
      { model: "gemini-test", messages: [{ role: "user", content: "hi" }], temperature: 0, responseFormat: "text" },
      { abortSignal: abort.signal } as RuntimeContext,
    )

    expect(model.id).toBe("gemini")
    expect(model.provider).toBe("gemini")
    expect(calls[0]?.url).toBe("https://generativelanguage.googleapis.com/v1beta/openai/chat/completions")
    expect(calls[0]?.init.signal).toBe(abort.signal)
    expect(calls[0]?.init.headers).toMatchObject({
      authorization: "Bearer gemini-key",
    })
    expect(response.text).toBe("ok")
  })
})

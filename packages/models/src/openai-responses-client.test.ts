import { describe, expect, it } from "bun:test"
import { OpenAIResponsesClient } from "./openai-responses-client"

describe("OpenAIResponsesClient", () => {
  it("constructs Responses API requests and parses output text", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const client = new OpenAIResponsesClient({
      baseUrl: "https://provider.test/v1",
      accessToken: "oauth-token",
      fetch: async (url, init) => {
        calls.push({ url: String(url), init: init ?? {} })
        return Response.json({
          id: "resp_1",
          output_text: "hello",
          usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
        })
      },
    })

    const response = await client.complete({
      model: "gpt-test",
      messages: [
        { role: "system", content: "Answer as JSON." },
        { role: "user", content: "Say hello" },
      ],
      temperature: 0.4,
      topP: 0.9,
      maxTokens: 512,
      extraBody: { service_tier: "flex" },
      responseFormat: "json",
    })

    expect(calls[0]?.url).toBe("https://provider.test/v1/responses")
    expect(calls[0]?.init.headers).toMatchObject({
      authorization: "Bearer oauth-token",
      "content-type": "application/json",
    })
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      model: "gpt-test",
      input: [{ role: "user", content: "Say hello" }],
      instructions: "Answer as JSON.",
      temperature: 0.4,
      top_p: 0.9,
      max_output_tokens: 512,
      service_tier: "flex",
      text: { format: { type: "json_object" } },
    })
    expect(response).toMatchObject({
      id: "resp_1",
      text: "hello",
      usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
    })
  })

  it("extracts text from output message content when output_text is absent", async () => {
    const client = new OpenAIResponsesClient({
      baseUrl: "https://provider.test/v1",
      accessToken: "oauth-token",
      fetch: async () =>
        Response.json({
          id: "resp_2",
          output: [
            {
              type: "message",
              content: [
                { type: "output_text", text: "from output content" },
                { type: "refusal", refusal: "ignored" },
              ],
            },
          ],
        }),
    })

    const response = await client.complete({
      model: "gpt-test",
      messages: [{ role: "user", content: "Say hello" }],
      temperature: 0,
      responseFormat: "text",
    })

    expect(response.text).toBe("from output content")
  })
})

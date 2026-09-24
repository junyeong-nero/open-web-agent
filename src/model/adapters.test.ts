import { describe, expect, it } from "bun:test"
import { anthropicMessages } from "./anthropic"
import { openaiChat } from "./openai"
import { type FetchLike, ModelHttpError, type ModelRequest } from "./types"

function recordingFetch(response: unknown, status = 200) {
  const calls: Array<{ url: string; headers: Record<string, string>; body: any }> = []
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) })
    return new Response(JSON.stringify(response), { status })
  }
  return { calls, fetchImpl }
}

const request: ModelRequest = {
  system: "sys",
  tools: [{ name: "browser_click", description: "Click", inputSchema: { type: "object", properties: {} } }],
  messages: [
    { role: "user", content: [{ type: "text", text: "task" }] },
    { role: "assistant", text: "looking", toolCalls: [{ id: "c1", name: "browser_screenshot", arguments: {} }, { id: "c2", name: "browser_click", arguments: { ref: "e1" } }] },
    { role: "tool", toolCallId: "c1", name: "browser_screenshot", content: [{ type: "text", text: "shot" }, { type: "image", mimeType: "image/png", data: "AAA" }] },
    { role: "tool", toolCallId: "c2", name: "browser_click", content: [{ type: "text", text: "failed" }], isError: true },
  ],
}

describe("openaiChat", () => {
  it("maps messages, tools, and images to Chat Completions", async () => {
    const { calls, fetchImpl } = recordingFetch({
      choices: [{ message: { content: null, tool_calls: [{ id: "c3", function: { name: "browser_click", arguments: '{"ref":"e2"}' } }] } }],
      usage: { prompt_tokens: 10, completion_tokens: 2 },
    })
    const model = openaiChat({ model: "m", baseUrl: "http://x/v1/", apiKey: "k", extraBody: { temperature: 0 }, fetch: fetchImpl })
    const response = await model.complete(request)

    expect(calls[0].url).toBe("http://x/v1/chat/completions")
    expect(calls[0].headers.authorization).toBe("Bearer k")
    const { body } = calls[0]
    expect(body.temperature).toBe(0)
    expect(body.tools[0].function.name).toBe("browser_click")
    expect(body.messages.map((message: any) => message.role)).toEqual(["system", "user", "assistant", "tool", "tool", "user"])
    expect(body.messages[2].tool_calls[1].function.arguments).toBe('{"ref":"e1"}')
    expect(body.messages[5].content[1].image_url.url).toBe("data:image/png;base64,AAA")
    expect(response).toEqual({
      text: undefined,
      toolCalls: [{ id: "c3", name: "browser_click", arguments: { ref: "e2" } }],
      usage: { inputTokens: 10, outputTokens: 2 },
    })
  })

  it("surfaces HTTP errors", async () => {
    const { fetchImpl } = recordingFetch({ error: "nope" }, 401)
    expect(openaiChat({ model: "m", fetch: fetchImpl }).complete(request)).rejects.toBeInstanceOf(ModelHttpError)
  })
})

describe("anthropicMessages", () => {
  it("maps messages to the Messages API and merges tool results into one user turn", async () => {
    const { calls, fetchImpl } = recordingFetch({
      content: [{ type: "text", text: "done" }, { type: "tool_use", id: "t1", name: "browser_snapshot", input: {} }],
      usage: { input_tokens: 5, output_tokens: 1 },
    })
    const model = anthropicMessages({ model: "claude", apiKey: "k", fetch: fetchImpl })
    const response = await model.complete(request)

    expect(calls[0].url).toBe("https://api.anthropic.com/v1/messages")
    expect(calls[0].headers["x-api-key"]).toBe("k")
    const { body } = calls[0]
    expect(body.system).toBe("sys")
    expect(body.max_tokens).toBe(4096)
    expect(body.tools[0].input_schema.type).toBe("object")
    expect(body.messages.map((message: any) => message.role)).toEqual(["user", "assistant", "user"])
    expect(body.messages[1].content[2]).toEqual({ type: "tool_use", id: "c2", name: "browser_click", input: { ref: "e1" } })
    const [shot, failed] = body.messages[2].content
    expect(shot.content[1].source).toEqual({ type: "base64", media_type: "image/png", data: "AAA" })
    expect(failed.is_error).toBe(true)
    expect(response.text).toBe("done")
    expect(response.toolCalls).toEqual([{ id: "t1", name: "browser_snapshot", arguments: {} }])
  })
})

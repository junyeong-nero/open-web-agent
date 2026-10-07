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

// Response bodies in each API's documented shape; 11,268 input tokens with 11,265 cached is the probe in #161.
describe("usage and serving model", () => {
  const toolCall = { id: "call_1", type: "function", function: { name: "browser_click", arguments: '{"ref":"e2"}' } }

  it("reads OpenAI cached tokens and reports no cost", async () => {
    const { fetchImpl } = recordingFetch({
      id: "chatcmpl-1", object: "chat.completion", created: 1791331200, model: "gpt-6-luna",
      choices: [{ index: 0, message: { role: "assistant", content: null, tool_calls: [toolCall], refusal: null, annotations: [] }, logprobs: null, finish_reason: "tool_calls" }],
      usage: {
        prompt_tokens: 11268, completion_tokens: 26, total_tokens: 11294,
        prompt_tokens_details: { cached_tokens: 11265, audio_tokens: 0 },
        completion_tokens_details: { reasoning_tokens: 0, audio_tokens: 0, accepted_prediction_tokens: 0, rejected_prediction_tokens: 0 },
      },
      service_tier: "default", system_fingerprint: null,
    })
    const response = await openaiChat({ model: "gpt-6-luna", fetch: fetchImpl }).complete(request)
    expect(response.model).toBe("gpt-6-luna")
    expect(response.usage).toStrictEqual({ inputTokens: 11268, outputTokens: 26, cachedInputTokens: 11265 })
  })

  it("reads the model a router chose, the cost and cache writes from OpenRouter", async () => {
    const routed = recordingFetch({
      id: "gen-1791331200-a", provider: "Azure", model: "openai/gpt-6-luna", object: "chat.completion", created: 1791331200,
      choices: [{ logprobs: null, finish_reason: "tool_calls", native_finish_reason: "tool_calls", index: 0, message: { role: "assistant", content: "", tool_calls: [toolCall] } }],
      usage: {
        prompt_tokens: 11268, completion_tokens: 26, total_tokens: 11294, cost: 0.00012595,
        cost_details: { upstream_inference_cost: null }, prompt_tokens_details: { cached_tokens: 11265, audio_tokens: 0 },
        completion_tokens_details: { reasoning_tokens: 0 },
      },
    })
    const response = await openaiChat({ model: "typesafe/jev-router", fetch: routed.fetchImpl }).complete(request)
    expect(routed.calls[0].body.model).toBe("typesafe/jev-router")
    expect(response.model).toBe("openai/gpt-6-luna")
    expect(response.usage).toStrictEqual({ inputTokens: 11268, outputTokens: 26, cachedInputTokens: 11265, cost: 0.00012595 })

    // Models with explicit caching also report the tokens written to the cache. A reported zero stays zero.
    const written = recordingFetch({
      id: "gen-1791331200-b", provider: "Anthropic", model: "anthropic/claude-haiku-4.5", object: "chat.completion", created: 1791331200,
      choices: [{ logprobs: null, finish_reason: "tool_calls", native_finish_reason: "tool_use", index: 0, message: { role: "assistant", content: "", tool_calls: [toolCall] } }],
      usage: {
        prompt_tokens: 11268, completion_tokens: 26, total_tokens: 11294, cost: 0.01421425,
        prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 11265, audio_tokens: 0 },
      },
    })
    expect((await openaiChat({ model: "anthropic/claude-haiku-4.5", fetch: written.fetchImpl }).complete(request)).usage)
      .toStrictEqual({ inputTokens: 11268, outputTokens: 26, cachedInputTokens: 0, cacheWriteTokens: 11265, cost: 0.01421425 })
  })

  it("adds Anthropic cache reads and writes to the input tokens", async () => {
    const { fetchImpl } = recordingFetch({
      id: "msg_01", type: "message", role: "assistant", model: "claude-haiku-4-5-20251001",
      content: [{ type: "tool_use", id: "toolu_01", name: "browser_click", input: { ref: "e2" } }],
      stop_reason: "tool_use", stop_sequence: null,
      usage: {
        input_tokens: 3, cache_creation_input_tokens: 200, cache_read_input_tokens: 11065,
        cache_creation: { ephemeral_5m_input_tokens: 200, ephemeral_1h_input_tokens: 0 }, output_tokens: 26, service_tier: "standard",
      },
    })
    const response = await anthropicMessages({ model: "claude-haiku-4-5", fetch: fetchImpl }).complete(request)
    expect(response.model).toBe("claude-haiku-4-5-20251001")
    expect(response.usage).toStrictEqual({ inputTokens: 11268, outputTokens: 26, cachedInputTokens: 11065, cacheWriteTokens: 200 })
  })

  it("leaves out values an endpoint does not send instead of writing zeros", async () => {
    const replies = [
      // Gemini's OpenAI endpoint: no cache details or cost.
      { model: "gemini-3.1-flash-lite", usage: { prompt_tokens: 120, completion_tokens: 5, total_tokens: 125 } },
      // vLLM: details sent as null.
      { model: "Qwen/Qwen3-8B", usage: { prompt_tokens: 120, completion_tokens: 5, total_tokens: 125, prompt_tokens_details: null } },
    ]
    for (const reply of replies) {
      const { fetchImpl } = recordingFetch({ object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: "done" }, finish_reason: "stop" }], ...reply })
      const response = await openaiChat({ model: "m", fetch: fetchImpl }).complete(request)
      expect(response.model).toBe(reply.model)
      expect(response.usage).toStrictEqual({ inputTokens: 120, outputTokens: 5 })
    }
    const { fetchImpl } = recordingFetch({ content: [{ type: "text", text: "done" }], usage: { input_tokens: 7, output_tokens: 1, cache_read_input_tokens: null, cache_creation_input_tokens: null } })
    const response = await anthropicMessages({ model: "m", fetch: fetchImpl }).complete(request)
    expect(response.model).toBeUndefined()
    expect(response.usage).toStrictEqual({ inputTokens: 7, outputTokens: 1 })
  })
})

describe("model request diagnostics", () => {
  it("suggests explicit reasoning options for the reported compatibility error", async () => {
    const { fetchImpl } = recordingFetch({ error: { message: "Function tools with reasoning_effort are not supported. Set reasoning_effort to 'none'." } }, 400)
    await expect(openaiChat({ model: "m", fetch: fetchImpl }).complete(request)).rejects.toThrow(
      `Try --model-options '{"reasoning_effort":"none"}' (or OWA_MODEL_OPTIONS) if supported by this endpoint. No model options are changed automatically.`,
    )
    // A secondary model's hint names the setting that configured it.
    const escalate = openaiChat({ model: "m", fetch: fetchImpl, optionsSetting: { flag: "--escalate-model-options", env: "OWA_ESCALATE_MODEL_OPTIONS" } })
    await expect(escalate.complete(request)).rejects.toThrow(`Try --escalate-model-options '{"reasoning_effort":"none"}' (or OWA_ESCALATE_MODEL_OPTIONS) if supported`)
  })

  it("redacts API keys echoed by an endpoint from the error and its body", async () => {
    for (const create of [openaiChat, anthropicMessages]) {
      const { fetchImpl } = recordingFetch({ error: "Invalid key: test-secret-token" }, 401)
      try {
        await create({ model: "m", apiKey: "test-secret-token", fetch: fetchImpl }).complete(request)
        throw new Error("Expected request to fail")
      } catch (error) {
        expect(error).toBeInstanceOf(ModelHttpError)
        expect(String(error)).not.toContain("test-secret-token")
        expect((error as ModelHttpError).body).not.toContain("test-secret-token")
        expect(String(error)).toContain("[redacted]")
      }
    }
  })
})

import { describe, expect, it } from "bun:test"
import { EventBus, type RuntimeContext } from "@open-web-agent/core"
import { CodexOAuthModel } from "./codex-oauth-model"

describe("CodexOAuthModel", () => {
  it("uses Codex OAuth credentials with the Responses API", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const model = new CodexOAuthModel({
      accessToken: "oauth-token",
      defaultModel: "gpt-test",
      defaultParameters: { temperature: 0.2 },
      reasoningEffort: "high",
      contextWindowTokens: 256000,
      fetch: async (url, init) => {
        calls.push({ url: String(url), init: init ?? {} })
        return Response.json({ id: "resp_1", output_text: "codex oauth answer" })
      },
    })
    const ctx: RuntimeContext = {
      session: {
        id: "ses_1",
        projectPath: "/tmp/project",
        projectHash: "hash",
        createdAt: "2026-06-17T00:00:00.000Z",
      },
      runId: "run_1",
      runDir: "/tmp/run",
      modelId: "codex-oauth",
      environmentId: "playwright-browser",
      browserTools: [],
      abortSignal: new AbortController().signal,
      eventBus: new EventBus(),
      now: () => new Date("2026-06-17T00:00:00.000Z"),
      emit: async (type, payload, stepId = null) => ({
        id: "evt_1",
        runId: "run_1",
        sessionId: "ses_1",
        stepId,
        sequence: 0,
        type,
        payload,
        createdAt: "2026-06-17T00:00:00.000Z",
      }),
    }

    const response = await model.complete(
      { model: "", messages: [{ role: "user", content: "hi" }], temperature: 0, responseFormat: "text" },
      ctx,
    )

    expect(model).toMatchObject({
      id: "codex-oauth",
      name: "Codex OAuth",
      provider: "codex-oauth",
      modelName: "gpt-test",
      reasoningEffort: "high",
      contextWindowTokens: 256000,
    })
    expect(calls[0]?.url).toBe("https://api.openai.com/v1/responses")
    expect(calls[0]?.init.headers).toMatchObject({ authorization: "Bearer oauth-token" })
    expect(JSON.parse(String(calls[0]?.init.body))).toMatchObject({ model: "gpt-test", temperature: 0.2 })
    expect(response.text).toBe("codex oauth answer")
  })

  it("forwards configured reasoning effort to Responses API requests", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const model = new CodexOAuthModel({
      accessToken: "oauth-token",
      defaultModel: "gpt-test",
      reasoningEffort: "high",
      fetch: async (url, init) => {
        calls.push({ url: String(url), init: init ?? {} })
        return Response.json({ id: "resp_1", output_text: "ok" })
      },
    })

    await model.complete(
      { model: "", messages: [{ role: "user", content: "hi" }], temperature: 0, responseFormat: "text" },
      {} as never,
    )

    expect(JSON.parse(String(calls[0]?.init.body))).toMatchObject({
      model: "gpt-test",
      reasoning: { effort: "high" },
    })
  })
})

import { describe, expect, it } from "bun:test"
import { readModelConfig } from "./model-config"

describe("readModelConfig", () => {
  it("reads provider keys and default model from env", () => {
    expect(
      readModelConfig({
        OPENAI_API_KEY: "openai-key",
        OPENROUTER_API_KEY: "openrouter-key",
        OPEN_WEB_AGENT_MODEL: "custom-model",
      }),
    ).toEqual({
      defaultModel: "custom-model",
      openaiApiKey: "openai-key",
      openrouterApiKey: "openrouter-key",
    })
  })
})

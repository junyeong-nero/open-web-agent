import { describe, expect, it } from "bun:test"
import { getProviderCapabilities, PROVIDER_CAPABILITIES } from "./model-capabilities"

describe("model capabilities", () => {
  it("returns text+image for OpenAI, OpenRouter, Gemini, Claude", () => {
    expect(PROVIDER_CAPABILITIES.openai.input).toEqual(["text", "image"])
    expect(PROVIDER_CAPABILITIES.openrouter.input).toEqual(["text", "image"])
    expect(PROVIDER_CAPABILITIES.gemini.input).toEqual(["text", "image"])
    expect(PROVIDER_CAPABILITIES.claude.input).toEqual(["text", "image"])
  })

  it("returns text-only for codex-oauth", () => {
    expect(PROVIDER_CAPABILITIES["codex-oauth"].input).toEqual(["text"])
  })

  it("falls back to text-only for unknown providers", () => {
    expect(getProviderCapabilities("unknown").input).toEqual(["text"])
  })

  it("provides text output for all known providers", () => {
    for (const provider of Object.keys(PROVIDER_CAPABILITIES)) {
      expect(PROVIDER_CAPABILITIES[provider].output).toEqual(["text"])
    }
  })
})

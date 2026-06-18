import type { ModelPlugin } from "@open-web-agent/core"
import { OpenAIModel, type OpenAIModelOptions } from "./openai-model"
import { OpenRouterModel, type OpenRouterModelOptions } from "./openrouter-model"

export interface ProviderModelDefinition {
  id: string
  modelName: string
  contextWindowTokens: number
}

export const OPENAI_MODEL_POOL: ProviderModelDefinition[] = [
  { id: "openai:gpt-5.5", modelName: "gpt-5.5", contextWindowTokens: 1_000_000 },
  { id: "openai:gpt-5.4", modelName: "gpt-5.4", contextWindowTokens: 1_000_000 },
  { id: "openai:gpt-5.4-mini", modelName: "gpt-5.4-mini", contextWindowTokens: 400_000 },
  { id: "openai:gpt-5.4-nano", modelName: "gpt-5.4-nano", contextWindowTokens: 400_000 },
  { id: "openai:gpt-5.3-codex-spark", modelName: "gpt-5.3-codex-spark", contextWindowTokens: 400_000 },
  { id: "openai:gpt-5", modelName: "gpt-5", contextWindowTokens: 400_000 },
  { id: "openai:gpt-5-mini", modelName: "gpt-5-mini", contextWindowTokens: 400_000 },
  { id: "openai:gpt-5-nano", modelName: "gpt-5-nano", contextWindowTokens: 400_000 },
  { id: "openai:o3", modelName: "o3", contextWindowTokens: 200_000 },
  { id: "openai:o4-mini", modelName: "o4-mini", contextWindowTokens: 200_000 },
  { id: "openai:gpt-4.1", modelName: "gpt-4.1", contextWindowTokens: 1_000_000 },
  { id: "openai:gpt-4.1-mini", modelName: "gpt-4.1-mini", contextWindowTokens: 1_000_000 },
  { id: "openai:gpt-4.1-nano", modelName: "gpt-4.1-nano", contextWindowTokens: 1_000_000 },
]

export const OPENROUTER_MODEL_POOL: ProviderModelDefinition[] = [
  { id: "openrouter:nvidia/nemotron-3-super-120b-a12b:free", modelName: "nvidia/nemotron-3-super-120b-a12b:free", contextWindowTokens: 128_000 },
  { id: "openrouter:openrouter/owl-alpha", modelName: "openrouter/owl-alpha", contextWindowTokens: 128_000 },
  { id: "openrouter:openai/gpt-oss-120b:free", modelName: "openai/gpt-oss-120b:free", contextWindowTokens: 128_000 },
  { id: "openrouter:~openai/gpt-latest", modelName: "~openai/gpt-latest", contextWindowTokens: 1_050_000 },
  { id: "openrouter:~openai/gpt-mini-latest", modelName: "~openai/gpt-mini-latest", contextWindowTokens: 400_000 },
  { id: "openrouter:openai/gpt-5.5", modelName: "openai/gpt-5.5", contextWindowTokens: 1_050_000 },
  { id: "openrouter:openai/gpt-5.3-codex", modelName: "openai/gpt-5.3-codex", contextWindowTokens: 400_000 },
  { id: "openrouter:openai/gpt-5.2-codex", modelName: "openai/gpt-5.2-codex", contextWindowTokens: 400_000 },
  { id: "openrouter:~anthropic/claude-fable-latest", modelName: "~anthropic/claude-fable-latest", contextWindowTokens: 1_000_000 },
  { id: "openrouter:~anthropic/claude-opus-latest", modelName: "~anthropic/claude-opus-latest", contextWindowTokens: 1_000_000 },
  { id: "openrouter:~anthropic/claude-sonnet-latest", modelName: "~anthropic/claude-sonnet-latest", contextWindowTokens: 1_000_000 },
  { id: "openrouter:~anthropic/claude-haiku-latest", modelName: "~anthropic/claude-haiku-latest", contextWindowTokens: 200_000 },
  { id: "openrouter:anthropic/claude-fable-5", modelName: "anthropic/claude-fable-5", contextWindowTokens: 1_000_000 },
  { id: "openrouter:anthropic/claude-opus-4.8", modelName: "anthropic/claude-opus-4.8", contextWindowTokens: 1_000_000 },
  { id: "openrouter:anthropic/claude-sonnet-4.6", modelName: "anthropic/claude-sonnet-4.6", contextWindowTokens: 1_000_000 },
  { id: "openrouter:~google/gemini-pro-latest", modelName: "~google/gemini-pro-latest", contextWindowTokens: 1_048_576 },
  { id: "openrouter:~google/gemini-flash-latest", modelName: "~google/gemini-flash-latest", contextWindowTokens: 1_048_576 },
  { id: "openrouter:google/gemini-3.5-flash", modelName: "google/gemini-3.5-flash", contextWindowTokens: 1_048_576 },
  { id: "openrouter:google/gemini-3.1-pro-preview", modelName: "google/gemini-3.1-pro-preview", contextWindowTokens: 1_048_576 },
  { id: "openrouter:google/gemini-2.5-pro", modelName: "google/gemini-2.5-pro", contextWindowTokens: 1_048_576 },
  { id: "openrouter:google/gemini-2.5-flash", modelName: "google/gemini-2.5-flash", contextWindowTokens: 1_048_576 },
  { id: "openrouter:openrouter/fusion", modelName: "openrouter/fusion", contextWindowTokens: 1_000_000 },
  { id: "openrouter:openrouter/pareto-code", modelName: "openrouter/pareto-code", contextWindowTokens: 2_000_000 },
  { id: "openrouter:openrouter/auto", modelName: "openrouter/auto", contextWindowTokens: 2_000_000 },
  { id: "openrouter:openrouter/free", modelName: "openrouter/free", contextWindowTokens: 200_000 },
]

type OpenAIModelPoolOptions = Pick<
  OpenAIModelOptions,
  "apiKey" | "defaultParameters" | "reasoningEffort" | "fetch"
>

type OpenRouterModelPoolOptions = Pick<
  OpenRouterModelOptions,
  "apiKey" | "defaultParameters" | "reasoningEffort" | "fetch"
>

export function createOpenAIModelPool(options: OpenAIModelPoolOptions = {}): ModelPlugin[] {
  return OPENAI_MODEL_POOL.map(
    (definition) =>
      new OpenAIModel({
        ...options,
        id: definition.id,
        name: "OpenAI",
        defaultModel: definition.modelName,
        contextWindowTokens: definition.contextWindowTokens,
        forceDefaultModel: true,
      }),
  )
}

export function createOpenRouterModelPool(options: OpenRouterModelPoolOptions = {}): ModelPlugin[] {
  return OPENROUTER_MODEL_POOL.map(
    (definition) =>
      new OpenRouterModel({
        ...options,
        id: definition.id,
        name: "OpenRouter",
        defaultModel: definition.modelName,
        contextWindowTokens: definition.contextWindowTokens,
        forceDefaultModel: true,
      }),
  )
}

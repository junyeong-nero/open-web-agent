export interface ModelCatalogEntry {
  id: string
  name: string
  provider: string
  modelName: string
  contextWindowTokens: number | undefined
  supportsReasoning: boolean
}

const openaiModels: ModelCatalogEntry[] = [
  { id: "openai/gpt-5.5", name: "GPT-5.5", provider: "openai", modelName: "gpt-5.5", contextWindowTokens: 1_050_000, supportsReasoning: true },
  { id: "openai/gpt-5.5-pro", name: "GPT-5.5 Pro", provider: "openai", modelName: "gpt-5.5-pro", contextWindowTokens: 1_050_000, supportsReasoning: true },
  { id: "openai/gpt-5.5-instant", name: "GPT-5.5 Instant", provider: "openai", modelName: "gpt-5.5-instant", contextWindowTokens: 400_000, supportsReasoning: true },
  { id: "openai/gpt-5.4", name: "GPT-5.4", provider: "openai", modelName: "gpt-5.4", contextWindowTokens: 1_050_000, supportsReasoning: true },
  { id: "openai/gpt-5.4-pro", name: "GPT-5.4 Pro", provider: "openai", modelName: "gpt-5.4-pro", contextWindowTokens: 1_050_000, supportsReasoning: true },
  { id: "openai/gpt-5.4-mini", name: "GPT-5.4 Mini", provider: "openai", modelName: "gpt-5.4-mini", contextWindowTokens: 400_000, supportsReasoning: true },
  { id: "openai/gpt-5.4-nano", name: "GPT-5.4 Nano", provider: "openai", modelName: "gpt-5.4-nano", contextWindowTokens: 400_000, supportsReasoning: true },
  { id: "openai/gpt-5.3-codex", name: "GPT-5.3 Codex", provider: "openai", modelName: "gpt-5.3-codex", contextWindowTokens: 400_000, supportsReasoning: true },
  { id: "openai/gpt-5.3-chat-latest", name: "GPT-5.3 Chat", provider: "openai", modelName: "gpt-5.3-chat-latest", contextWindowTokens: 128_000, supportsReasoning: false },
  { id: "openai/gpt-5.2", name: "GPT-5.2", provider: "openai", modelName: "gpt-5.2", contextWindowTokens: 400_000, supportsReasoning: true },
  { id: "openai/gpt-5.2-codex", name: "GPT-5.2 Codex", provider: "openai", modelName: "gpt-5.2-codex", contextWindowTokens: 400_000, supportsReasoning: true },
  { id: "openai/gpt-5.2-pro", name: "GPT-5.2 Pro", provider: "openai", modelName: "gpt-5.2-pro", contextWindowTokens: 400_000, supportsReasoning: true },
  { id: "openai/gpt-5.2-chat-latest", name: "GPT-5.2 Chat", provider: "openai", modelName: "gpt-5.2-chat-latest", contextWindowTokens: 128_000, supportsReasoning: true },
  { id: "openai/gpt-5.1", name: "GPT-5.1", provider: "openai", modelName: "gpt-5.1", contextWindowTokens: 400_000, supportsReasoning: true },
  { id: "openai/gpt-5.1-codex", name: "GPT-5.1 Codex", provider: "openai", modelName: "gpt-5.1-codex", contextWindowTokens: 400_000, supportsReasoning: true },
  { id: "openai/gpt-5.1-codex-max", name: "GPT-5.1 Codex Max", provider: "openai", modelName: "gpt-5.1-codex-max", contextWindowTokens: 400_000, supportsReasoning: true },
  { id: "openai/gpt-5.1-codex-mini", name: "GPT-5.1 Codex Mini", provider: "openai", modelName: "gpt-5.1-codex-mini", contextWindowTokens: 400_000, supportsReasoning: true },
  { id: "openai/gpt-5.1-chat-latest", name: "GPT-5.1 Chat", provider: "openai", modelName: "gpt-5.1-chat-latest", contextWindowTokens: 128_000, supportsReasoning: true },
  { id: "openai/gpt-5", name: "GPT-5", provider: "openai", modelName: "gpt-5", contextWindowTokens: 400_000, supportsReasoning: true },
  { id: "openai/gpt-5-codex", name: "GPT-5 Codex", provider: "openai", modelName: "gpt-5-codex", contextWindowTokens: 400_000, supportsReasoning: true },
  { id: "openai/gpt-5-pro", name: "GPT-5 Pro", provider: "openai", modelName: "gpt-5-pro", contextWindowTokens: 400_000, supportsReasoning: true },
  { id: "openai/gpt-5-mini", name: "GPT-5 Mini", provider: "openai", modelName: "gpt-5-mini", contextWindowTokens: 400_000, supportsReasoning: true },
  { id: "openai/gpt-5-nano", name: "GPT-5 Nano", provider: "openai", modelName: "gpt-5-nano", contextWindowTokens: 400_000, supportsReasoning: true },
  { id: "openai/gpt-4.1", name: "GPT-4.1", provider: "openai", modelName: "gpt-4.1", contextWindowTokens: 1_047_576, supportsReasoning: false },
  { id: "openai/gpt-4.1-mini", name: "GPT-4.1 Mini", provider: "openai", modelName: "gpt-4.1-mini", contextWindowTokens: 1_047_576, supportsReasoning: false },
  { id: "openai/gpt-4.1-nano", name: "GPT-4.1 Nano", provider: "openai", modelName: "gpt-4.1-nano", contextWindowTokens: 1_047_576, supportsReasoning: false },
  { id: "openai/gpt-4o", name: "GPT-4o", provider: "openai", modelName: "gpt-4o", contextWindowTokens: 128_000, supportsReasoning: false },
  { id: "openai/gpt-4o-mini", name: "GPT-4o Mini", provider: "openai", modelName: "gpt-4o-mini", contextWindowTokens: 128_000, supportsReasoning: false },
  { id: "openai/o4-mini", name: "o4-mini", provider: "openai", modelName: "o4-mini", contextWindowTokens: 200_000, supportsReasoning: true },
  { id: "openai/o3", name: "o3", provider: "openai", modelName: "o3", contextWindowTokens: 200_000, supportsReasoning: true },
  { id: "openai/o3-mini", name: "o3-mini", provider: "openai", modelName: "o3-mini", contextWindowTokens: 200_000, supportsReasoning: true },
  { id: "openai/o3-pro", name: "o3-pro", provider: "openai", modelName: "o3-pro", contextWindowTokens: 200_000, supportsReasoning: true },
  { id: "openai/o1", name: "o1", provider: "openai", modelName: "o1", contextWindowTokens: 200_000, supportsReasoning: true },
  { id: "openai/o1-pro", name: "o1-pro", provider: "openai", modelName: "o1-pro", contextWindowTokens: 200_000, supportsReasoning: true },
]

const anthropicModels: ModelCatalogEntry[] = [
  { id: "claude/claude-opus-4-8", name: "Claude Opus 4.8", provider: "claude", modelName: "claude-opus-4-8", contextWindowTokens: 1_000_000, supportsReasoning: true },
  { id: "claude/claude-opus-4-7", name: "Claude Opus 4.7", provider: "claude", modelName: "claude-opus-4-7", contextWindowTokens: 1_000_000, supportsReasoning: true },
  { id: "claude/claude-opus-4-6", name: "Claude Opus 4.6", provider: "claude", modelName: "claude-opus-4-6", contextWindowTokens: 1_000_000, supportsReasoning: true },
  { id: "claude/claude-opus-4-5", name: "Claude Opus 4.5", provider: "claude", modelName: "claude-opus-4-5", contextWindowTokens: 200_000, supportsReasoning: true },
  { id: "claude/claude-opus-4-1", name: "Claude Opus 4.1", provider: "claude", modelName: "claude-opus-4-1", contextWindowTokens: 200_000, supportsReasoning: true },
  { id: "claude/claude-opus-4", name: "Claude Opus 4", provider: "claude", modelName: "claude-opus-4", contextWindowTokens: 200_000, supportsReasoning: true },
  { id: "claude/claude-sonnet-4-6", name: "Claude Sonnet 4.6", provider: "claude", modelName: "claude-sonnet-4-6", contextWindowTokens: 1_000_000, supportsReasoning: true },
  { id: "claude/claude-sonnet-4-5", name: "Claude Sonnet 4.5", provider: "claude", modelName: "claude-sonnet-4-5", contextWindowTokens: 200_000, supportsReasoning: true },
  { id: "claude/claude-sonnet-4", name: "Claude Sonnet 4", provider: "claude", modelName: "claude-sonnet-4", contextWindowTokens: 200_000, supportsReasoning: true },
  { id: "claude/claude-haiku-4-5", name: "Claude Haiku 4.5", provider: "claude", modelName: "claude-haiku-4-5", contextWindowTokens: 200_000, supportsReasoning: true },
  { id: "claude/claude-fable-5", name: "Claude Fable 5", provider: "claude", modelName: "claude-fable-5", contextWindowTokens: 1_000_000, supportsReasoning: true },
  { id: "claude/claude-3-7-sonnet", name: "Claude 3.7 Sonnet", provider: "claude", modelName: "claude-3-7-sonnet-20250219", contextWindowTokens: 200_000, supportsReasoning: true },
  { id: "claude/claude-3-5-sonnet", name: "Claude 3.5 Sonnet", provider: "claude", modelName: "claude-3-5-sonnet-20241022", contextWindowTokens: 200_000, supportsReasoning: false },
  { id: "claude/claude-3-5-haiku", name: "Claude 3.5 Haiku", provider: "claude", modelName: "claude-3-5-haiku-20241022", contextWindowTokens: 200_000, supportsReasoning: false },
]

const geminiModels: ModelCatalogEntry[] = [
  { id: "gemini/gemini-3.5-flash", name: "Gemini 3.5 Flash", provider: "gemini", modelName: "gemini-3.5-flash", contextWindowTokens: 1_048_576, supportsReasoning: true },
  { id: "gemini/gemini-3.1-pro-preview", name: "Gemini 3.1 Pro Preview", provider: "gemini", modelName: "gemini-3.1-pro-preview", contextWindowTokens: 1_048_576, supportsReasoning: true },
  { id: "gemini/gemini-3.1-flash-lite", name: "Gemini 3.1 Flash Lite", provider: "gemini", modelName: "gemini-3.1-flash-lite", contextWindowTokens: 1_048_576, supportsReasoning: true },
  { id: "gemini/gemini-3-pro-preview", name: "Gemini 3 Pro Preview", provider: "gemini", modelName: "gemini-3-pro-preview", contextWindowTokens: 1_048_576, supportsReasoning: true },
  { id: "gemini/gemini-3-flash-preview", name: "Gemini 3 Flash Preview", provider: "gemini", modelName: "gemini-3-flash-preview", contextWindowTokens: 1_048_576, supportsReasoning: true },
  { id: "gemini/gemini-2.5-pro", name: "Gemini 2.5 Pro", provider: "gemini", modelName: "gemini-2.5-pro", contextWindowTokens: 1_048_576, supportsReasoning: true },
  { id: "gemini/gemini-2.5-flash", name: "Gemini 2.5 Flash", provider: "gemini", modelName: "gemini-2.5-flash", contextWindowTokens: 1_048_576, supportsReasoning: true },
  { id: "gemini/gemini-2.5-flash-lite", name: "Gemini 2.5 Flash Lite", provider: "gemini", modelName: "gemini-2.5-flash-lite", contextWindowTokens: 1_048_576, supportsReasoning: true },
  { id: "gemini/gemini-2.0-flash", name: "Gemini 2.0 Flash", provider: "gemini", modelName: "gemini-2.0-flash", contextWindowTokens: 1_048_576, supportsReasoning: false },
  { id: "gemini/gemini-2.0-flash-lite", name: "Gemini 2.0 Flash Lite", provider: "gemini", modelName: "gemini-2.0-flash-lite", contextWindowTokens: 1_048_576, supportsReasoning: false },
  { id: "gemini/gemma-4-26b-a4b-it", name: "Gemma 4 26B A4B IT", provider: "gemini", modelName: "gemma-4-26b-a4b-it", contextWindowTokens: 262_144, supportsReasoning: true },
  { id: "gemini/gemma-4-31b-it", name: "Gemma 4 31B IT", provider: "gemini", modelName: "gemma-4-31b-it", contextWindowTokens: 262_144, supportsReasoning: true },
]

const deepseekModels: ModelCatalogEntry[] = [
  { id: "deepseek/deepseek-v4-pro", name: "DeepSeek V4 Pro", provider: "deepseek", modelName: "deepseek-v4-pro", contextWindowTokens: 1_000_000, supportsReasoning: true },
  { id: "deepseek/deepseek-v4-flash", name: "DeepSeek V4 Flash", provider: "deepseek", modelName: "deepseek-v4-flash", contextWindowTokens: 1_000_000, supportsReasoning: true },
  { id: "deepseek/deepseek-reasoner", name: "DeepSeek Reasoner", provider: "deepseek", modelName: "deepseek-reasoner", contextWindowTokens: 1_000_000, supportsReasoning: true },
  { id: "deepseek/deepseek-chat", name: "DeepSeek Chat", provider: "deepseek", modelName: "deepseek-chat", contextWindowTokens: 1_000_000, supportsReasoning: false },
  { id: "deepseek/deepseek-r1", name: "DeepSeek-R1", provider: "deepseek", modelName: "deepseek-r1", contextWindowTokens: 128_000, supportsReasoning: true },
]

const mistralModels: ModelCatalogEntry[] = [
  { id: "mistral/mistral-large-latest", name: "Mistral Large", provider: "mistral", modelName: "mistral-large-latest", contextWindowTokens: 262_144, supportsReasoning: false },
  { id: "mistral/mistral-medium-latest", name: "Mistral Medium", provider: "mistral", modelName: "mistral-medium-latest", contextWindowTokens: 262_144, supportsReasoning: true },
  { id: "mistral/mistral-small-latest", name: "Mistral Small", provider: "mistral", modelName: "mistral-small-latest", contextWindowTokens: 256_000, supportsReasoning: true },
  { id: "mistral/codestral-latest", name: "Codestral", provider: "mistral", modelName: "codestral-latest", contextWindowTokens: 256_000, supportsReasoning: false },
  { id: "mistral/pixtral-large-latest", name: "Pixtral Large", provider: "mistral", modelName: "pixtral-large-latest", contextWindowTokens: 128_000, supportsReasoning: false },
  { id: "mistral/mistral-nemo", name: "Mistral Nemo", provider: "mistral", modelName: "mistral-nemo", contextWindowTokens: 128_000, supportsReasoning: false },
]

const xaiModels: ModelCatalogEntry[] = [
  { id: "xai/grok-4.3", name: "Grok 4.3", provider: "xai", modelName: "grok-4.3", contextWindowTokens: 1_000_000, supportsReasoning: true },
  { id: "xai/grok-4.20-reasoning", name: "Grok 4.20 Reasoning", provider: "xai", modelName: "grok-4.20-0309-reasoning", contextWindowTokens: 1_000_000, supportsReasoning: true },
  { id: "xai/grok-4.20", name: "Grok 4.20", provider: "xai", modelName: "grok-4.20-0309-non-reasoning", contextWindowTokens: 1_000_000, supportsReasoning: false },
]

const nvidiaModels: ModelCatalogEntry[] = [
  { id: "nvidia/nemotron-3-ultra-550b-a55b", name: "Nemotron 3 Ultra 550B A55B", provider: "nvidia", modelName: "nvidia/nemotron-3-ultra-550b-a55b", contextWindowTokens: 1_000_000, supportsReasoning: true },
  { id: "nvidia/nemotron-3-super-120b-a12b", name: "Nemotron 3 Super 120B A12B", provider: "nvidia", modelName: "nvidia/nemotron-3-super-120b-a12b", contextWindowTokens: 262_144, supportsReasoning: true },
  { id: "nvidia/nemotron-3-nano-30b-a3b", name: "Nemotron 3 Nano 30B A3B", provider: "nvidia", modelName: "nvidia/nemotron-3-nano-30b-a3b", contextWindowTokens: 262_144, supportsReasoning: true },
  { id: "nvidia/nemotron-3-super-120b-a12b:free", name: "Nemotron 3 Super 120B A12B (Free)", provider: "nvidia", modelName: "nvidia/nemotron-3-super-120b-a12b:free", contextWindowTokens: 262_144, supportsReasoning: true },
]

const metaModels: ModelCatalogEntry[] = [
  { id: "meta/llama-4-maverick-17b-instruct", name: "Llama 4 Maverick 17B", provider: "meta", modelName: "llama-4-maverick-17b-instruct", contextWindowTokens: 1_000_000, supportsReasoning: false },
  { id: "meta/llama-4-scout-17b-instruct", name: "Llama 4 Scout 17B", provider: "meta", modelName: "llama-4-scout-17b-instruct", contextWindowTokens: 3_500_000, supportsReasoning: false },
  { id: "meta/llama-3.3-70b-instruct", name: "Llama 3.3 70B", provider: "meta", modelName: "llama-3.3-70b-instruct", contextWindowTokens: 128_000, supportsReasoning: false },
]

const cohereModels: ModelCatalogEntry[] = [
  { id: "cohere/command-a-plus", name: "Command A+", provider: "cohere", modelName: "command-a-plus-05-2026", contextWindowTokens: 128_000, supportsReasoning: true },
  { id: "cohere/command-a", name: "Command A", provider: "cohere", modelName: "command-a-03-2025", contextWindowTokens: 256_000, supportsReasoning: false },
]

const perplexityModels: ModelCatalogEntry[] = [
  { id: "perplexity/sonar-reasoning-pro", name: "Sonar Reasoning Pro", provider: "perplexity", modelName: "sonar-reasoning-pro", contextWindowTokens: 128_000, supportsReasoning: true },
  { id: "perplexity/sonar-pro", name: "Sonar Pro", provider: "perplexity", modelName: "sonar-pro", contextWindowTokens: 200_000, supportsReasoning: false },
  { id: "perplexity/sonar", name: "Sonar", provider: "perplexity", modelName: "sonar", contextWindowTokens: 128_000, supportsReasoning: false },
]

export const MODEL_CATALOG: ModelCatalogEntry[] = [
  ...openaiModels,
  ...anthropicModels,
  ...geminiModels,
  ...deepseekModels,
  ...mistralModels,
  ...xaiModels,
  ...nvidiaModels,
  ...metaModels,
  ...cohereModels,
  ...perplexityModels,
]

export function getCatalogModelsByProvider(provider: string): ModelCatalogEntry[] {
  return MODEL_CATALOG.filter((entry) => entry.provider === provider)
}

export function getCatalogModel(id: string): ModelCatalogEntry | undefined {
  return MODEL_CATALOG.find((entry) => entry.id === id)
}

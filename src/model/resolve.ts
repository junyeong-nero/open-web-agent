import { isAbsolute, resolve as resolvePath } from "node:path"
import { pathToFileURL } from "node:url"
import { anthropicMessages } from "./anthropic"
import { openaiChat } from "./openai"
import type { ModelAdapter } from "./types"

export type ApiFormat = "openai" | "anthropic"

interface ProviderPreset {
  api: ApiFormat
  baseUrl: string
  keyEnv?: string
}

/** Provider names are only shorthands for an API format + base URL + key env var. */
export const PROVIDERS: Record<string, ProviderPreset> = {
  openai: { api: "openai", baseUrl: "https://api.openai.com/v1", keyEnv: "OPENAI_API_KEY" },
  anthropic: { api: "anthropic", baseUrl: "https://api.anthropic.com/v1", keyEnv: "ANTHROPIC_API_KEY" },
  openrouter: { api: "openai", baseUrl: "https://openrouter.ai/api/v1", keyEnv: "OPENROUTER_API_KEY" },
  gemini: { api: "openai", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", keyEnv: "GEMINI_API_KEY" },
  ollama: { api: "openai", baseUrl: "http://localhost:11434/v1" },
}

export interface ModelConfig {
  /** `provider:model` (e.g. `openrouter:anthropic/claude-sonnet-5`, `ollama:qwen3:8b`) or a bare model name. */
  model?: string
  provider?: string
  api?: ApiFormat
  baseUrl?: string
  apiKey?: string
  /** Path to a module whose default export is a ModelAdapter or `(config) => ModelAdapter`. */
  module?: string
  maxTokens?: number
}

export function modelConfigFromEnv(env: Record<string, string | undefined> = process.env): ModelConfig {
  return {
    model: env.OWA_MODEL,
    provider: env.OWA_PROVIDER,
    api: parseApi(env.OWA_API),
    baseUrl: env.OWA_BASE_URL,
    apiKey: env.OWA_API_KEY,
    module: env.OWA_MODEL_MODULE,
  }
}

export function parseApi(value: string | undefined): ApiFormat | undefined {
  if (value === undefined || value === "") return undefined
  if (value === "openai" || value === "anthropic") return value
  throw new Error(`Unknown API format "${value}" (expected "openai" or "anthropic")`)
}

export function splitModelSpec(spec: string): { provider?: string; model: string } {
  const colon = spec.indexOf(":")
  if (colon > 0) {
    const prefix = spec.slice(0, colon)
    if (prefix in PROVIDERS) return { provider: prefix, model: spec.slice(colon + 1) }
  }
  return { model: spec }
}

export async function resolveModel(
  config: ModelConfig,
  env: Record<string, string | undefined> = process.env,
): Promise<ModelAdapter> {
  if (config.module) return loadModelModule(config.module, config)

  if (!config.model) {
    throw new Error(
      "No model configured. Pass --model <provider:model> (e.g. openai:gpt-5-mini, anthropic:claude-sonnet-5, ollama:qwen3:8b) or set OWA_MODEL.",
    )
  }

  const spec = splitModelSpec(config.model)
  const providerName = spec.provider ?? config.provider ?? (config.baseUrl ? undefined : "openai")
  const preset = providerName ? PROVIDERS[providerName] : undefined
  if (providerName && !preset) {
    throw new Error(`Unknown provider "${providerName}". Known: ${Object.keys(PROVIDERS).join(", ")}; or pass --base-url and --api.`)
  }

  const api = config.api ?? preset?.api ?? "openai"
  const baseUrl = config.baseUrl ?? preset?.baseUrl
  const apiKey = config.apiKey ?? (preset?.keyEnv ? env[preset.keyEnv] : undefined)
  if (preset?.keyEnv && !apiKey) {
    throw new Error(`Model provider "${providerName}" needs an API key: set ${preset.keyEnv} or OWA_API_KEY.`)
  }

  return api === "anthropic"
    ? anthropicMessages({ model: spec.model, baseUrl, apiKey, maxTokens: config.maxTokens })
    : openaiChat({ model: spec.model, baseUrl, apiKey })
}

async function loadModelModule(path: string, config: ModelConfig): Promise<ModelAdapter> {
  const url = pathToFileURL(isAbsolute(path) ? path : resolvePath(process.cwd(), path)).href
  const loaded = (await import(url)) as { default?: unknown }
  const exported = loaded.default
  const adapter = typeof exported === "function" ? await exported(config) : exported
  if (!adapter || typeof (adapter as ModelAdapter).complete !== "function") {
    throw new Error(`Model module ${path} must default-export a ModelAdapter or a function returning one`)
  }
  return adapter as ModelAdapter
}

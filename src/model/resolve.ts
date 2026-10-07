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
  /** Additional API request fields, supplied explicitly without model-specific defaults. */
  extraBody?: Record<string, unknown>
  /** The flag and environment variable that set `extraBody`, for error hints; defaults to the main model's. */
  optionsSetting?: { flag: string; env: string }
}

export function modelConfigFromEnv(env: Record<string, string | undefined> = process.env): ModelConfig {
  return {
    model: env.OWA_MODEL,
    provider: env.OWA_PROVIDER,
    api: parseApi(env.OWA_API),
    baseUrl: env.OWA_BASE_URL,
    apiKey: env.OWA_API_KEY,
    module: env.OWA_MODEL_MODULE,
    extraBody: parseModelOptions(env.OWA_MODEL_OPTIONS),
  }
}

/**
 * Config for an opt-in secondary model with one role, such as `escalate`: `--<role>-model` or `OWA_<ROLE>_MODEL`, and
 * optional `--<role>-model-options` or `OWA_<ROLE>_MODEL_OPTIONS`, flag before env as for the main model. Undefined when
 * the model is unset or empty, so an empty flag turns off an environment setting. Only the `provider:model` spec and
 * options apply: the main model's base URL, API format, module and OWA_API_KEY do not, so a key never reaches another
 * provider. Pass the result to `resolveModel`, which reads that provider's own key variable.
 */
export function roleModelConfig(
  role: string,
  flags: { model?: string; options?: string },
  env: Record<string, string | undefined> = process.env,
): ModelConfig | undefined {
  const variable = `OWA_${role.toUpperCase()}_MODEL`
  const optionsSetting = { flag: `--${role}-model-options`, env: `${variable}_OPTIONS` }
  const model = flags.model ?? env[variable]
  const options = flags.options ?? env[optionsSetting.env]
  const label = `${optionsSetting.flag} / ${optionsSetting.env}`
  if (model === undefined && options !== undefined) throw new Error(`${label} needs --${role}-model or ${variable}`)
  return model ? { model, extraBody: parseModelOptions(options, label), optionsSetting } : undefined
}

const RESERVED_OPTIONS = ["model", "messages", "tools", "system", "stream", "api_key", "apiKey", "authorization", "headers"]

export function parseModelOptions(value: string | undefined, label = "--model-options / OWA_MODEL_OPTIONS"): Record<string, unknown> | undefined {
  if (value === undefined) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    // Do not echo JSON or parser errors: the supplied value may contain credentials.
    throw new Error(`${label} must be a JSON object`)
  }
  return validateModelOptions(parsed, label)
}

function validateModelOptions(value: unknown, label = "--model-options / OWA_MODEL_OPTIONS"): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`)
  }
  for (const key of RESERVED_OPTIONS) {
    if (Object.hasOwn(value, key)) throw new Error(`Model options cannot set "${key}"; use the dedicated model/auth configuration and let the agent manage messages and tools`)
  }
  return value as Record<string, unknown>
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
  const extraBody = config.extraBody === undefined ? undefined : validateModelOptions(config.extraBody)
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
    ? anthropicMessages({ model: spec.model, baseUrl, apiKey, maxTokens: config.maxTokens, extraBody })
    : openaiChat({ model: spec.model, baseUrl, apiKey, extraBody, optionsSetting: config.optionsSetting })
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

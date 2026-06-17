import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { parse } from "yaml"

export interface ModelConfig {
  defaultModel: string
  reasoningEffort: string
  contextWindowTokens: number
  openaiApiKey: string | null
  openrouterApiKey: string | null
}

export interface ReadModelConfigOptions {
  configPath?: string
}

const defaultModel = "gpt-4.1-mini"
const defaultReasoningEffort = "medium"
const defaultContextWindowTokens = 128000

export function resolveModelConfigPath(): string {
  return join(homedir(), ".openwebagents", "config.yaml")
}

export function readModelConfig(env: NodeJS.ProcessEnv = process.env, options: ReadModelConfigOptions = {}): ModelConfig {
  const fileConfig = readConfigFile(options.configPath ?? resolveModelConfigPath())

  return {
    defaultModel: env.OPEN_WEB_AGENT_MODEL || fileConfig.defaultModel || defaultModel,
    reasoningEffort: env.OPEN_WEB_AGENT_REASONING_EFFORT || fileConfig.reasoningEffort || defaultReasoningEffort,
    contextWindowTokens: readContextWindowTokens(env.OPEN_WEB_AGENT_CONTEXT_WINDOW_TOKENS) ?? fileConfig.contextWindowTokens ?? defaultContextWindowTokens,
    openaiApiKey: env.OPENAI_API_KEY || fileConfig.openaiApiKey || null,
    openrouterApiKey: env.OPENROUTER_API_KEY || fileConfig.openrouterApiKey || null,
  }
}

function readConfigFile(configPath: string): Partial<ModelConfig> {
  let raw: string
  try {
    raw = readFileSync(configPath, "utf8")
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return {}
    throw error
  }

  const parsed = parse(raw)
  if (parsed == null) return {}
  if (!isRecord(parsed)) throw new Error(`Invalid Open Web Agent config at ${configPath}: expected a YAML mapping`)

  return {
    defaultModel: readOptionalString(parsed, configPath, "default_model", "defaultModel", "model"),
    reasoningEffort: readOptionalString(parsed, configPath, "reasoning_effort", "reasoningEffort"),
    contextWindowTokens: readOptionalPositiveInteger(parsed, configPath, "context_window_tokens", "contextWindowTokens"),
    openaiApiKey: readOptionalString(parsed, configPath, "openai_api_key", "openaiApiKey"),
    openrouterApiKey: readOptionalString(parsed, configPath, "openrouter_api_key", "openrouterApiKey"),
  }
}

function readOptionalString(record: Record<string, unknown>, configPath: string, ...keys: string[]): string | undefined {
  for (const key of keys) {
    if (!(key in record)) continue
    const value = record[key]
    if (value == null) return undefined
    if (typeof value !== "string") {
      throw new Error(`Invalid Open Web Agent config at ${configPath}: ${key} must be a string`)
    }
    if (value.length > 0) return value
  }

  return undefined
}

function readOptionalPositiveInteger(record: Record<string, unknown>, configPath: string, ...keys: string[]): number | undefined {
  for (const key of keys) {
    if (!(key in record)) continue
    const value = record[key]
    if (value == null) return undefined
    if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
      throw new Error(`Invalid Open Web Agent config at ${configPath}: ${key} must be a positive integer`)
    }
    return value
  }

  return undefined
}

function readContextWindowTokens(value: string | undefined): number | undefined {
  if (!value) return undefined
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error("Invalid OPEN_WEB_AGENT_CONTEXT_WINDOW_TOKENS: must be a positive integer")
  }
  return parsed
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value != null && !Array.isArray(value)
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error
}

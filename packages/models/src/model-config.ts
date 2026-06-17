import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { parse } from "yaml"

export interface ModelConfig {
  defaultModel: string
  openaiApiKey: string | null
  openrouterApiKey: string | null
}

export interface ReadModelConfigOptions {
  configPath?: string
}

const defaultModel = "gpt-4.1-mini"

export function resolveModelConfigPath(): string {
  return join(homedir(), ".openwebagents", "config.yaml")
}

export function readModelConfig(env: NodeJS.ProcessEnv = process.env, options: ReadModelConfigOptions = {}): ModelConfig {
  const fileConfig = readConfigFile(options.configPath ?? resolveModelConfigPath())

  return {
    defaultModel: env.OPEN_WEB_AGENT_MODEL || fileConfig.defaultModel || defaultModel,
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value != null && !Array.isArray(value)
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error
}

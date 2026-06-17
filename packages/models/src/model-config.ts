import { readFileSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { parse, stringify } from "yaml"
import { resolveCodexAuthPath } from "./codex-auth"

export interface ModelConfig {
  defaultModel: string
  defaultModelProvider: string | null
  reasoningEffort: string
  contextWindowTokens: number
  openaiApiKey: string | null
  openrouterApiKey: string | null
  codexAuthPath: string
  parameters: ModelParameters
}

export interface ModelParameters {
  temperature?: number
  topP?: number
  maxTokens?: number
  presencePenalty?: number
  frequencyPenalty?: number
  seed?: number
  stop?: string | string[]
  extraBody?: Record<string, unknown>
}

export interface ReadModelConfigOptions {
  configPath?: string
  legacyConfigPath?: string
}

export interface WriteModelSelectionConfigOptions {
  configPath?: string
}

export interface ModelSelectionConfig {
  modelId: string
  modelName?: string | null
}

const defaultModel = "gpt-4.1-mini"
const defaultReasoningEffort = "medium"
const defaultContextWindowTokens = 128000

export function resolveModelConfigPath(): string {
  return join(homedir(), ".open-web-agent", ".config.yaml")
}

export function resolveLegacyModelConfigPath(): string {
  return join(homedir(), ".openwebagents", "config.yaml")
}

export function readModelConfig(env: NodeJS.ProcessEnv = process.env, options: ReadModelConfigOptions = {}): ModelConfig {
  const configPath = options.configPath ?? resolveModelConfigPath()
  const legacyConfigPath = options.legacyConfigPath ?? (options.configPath ? undefined : resolveLegacyModelConfigPath())
  const fileConfigResult = readConfigFile(configPath)
  const fileConfig =
    fileConfigResult.found || !legacyConfigPath ? fileConfigResult.config : readConfigFile(legacyConfigPath).config

  return {
    defaultModel: env.OPEN_WEB_AGENT_MODEL || fileConfig.defaultModel || defaultModel,
    defaultModelProvider: env.OPEN_WEB_AGENT_MODEL_PROVIDER || fileConfig.defaultModelProvider || null,
    reasoningEffort: env.OPEN_WEB_AGENT_REASONING_EFFORT || fileConfig.reasoningEffort || defaultReasoningEffort,
    contextWindowTokens: readContextWindowTokens(env.OPEN_WEB_AGENT_CONTEXT_WINDOW_TOKENS) ?? fileConfig.contextWindowTokens ?? defaultContextWindowTokens,
    openaiApiKey: env.OPENAI_API_KEY || fileConfig.openaiApiKey || null,
    openrouterApiKey: env.OPENROUTER_API_KEY || fileConfig.openrouterApiKey || null,
    codexAuthPath: expandHomePath(env.OPEN_WEB_AGENT_CODEX_AUTH_PATH || fileConfig.codexAuthPath || resolveCodexAuthPath(env.CODEX_HOME)),
    parameters: fileConfig.parameters ?? {},
  }
}

export async function writeModelSelectionConfig(
  selection: ModelSelectionConfig,
  options: WriteModelSelectionConfigOptions = {},
): Promise<void> {
  const configPath = options.configPath ?? resolveModelConfigPath()
  const parsed = await readRawConfigMapping(configPath)
  const next = {
    ...parsed,
    model_provider: selection.modelId,
    ...(selection.modelName && selection.modelName.length > 0 ? { model: selection.modelName } : {}),
  }

  await mkdir(dirname(configPath), { recursive: true })
  await writeFile(configPath, stringify(next), "utf8")
}

function readConfigFile(configPath: string): { config: Partial<ModelConfig>; found: boolean } {
  let raw: string
  try {
    raw = readFileSync(configPath, "utf8")
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return { config: {}, found: false }
    throw error
  }

  const parsed = parse(raw)
  if (parsed == null) return { config: {}, found: true }
  if (!isRecord(parsed)) throw new Error(`Invalid Open Web Agent config at ${configPath}: expected a YAML mapping`)

  return {
    config: {
      defaultModel: readOptionalString(parsed, configPath, "default_model", "defaultModel", "model"),
      defaultModelProvider: readOptionalString(parsed, configPath, "model_provider", "modelProvider"),
      reasoningEffort: readOptionalString(parsed, configPath, "reasoning_effort", "reasoningEffort"),
      contextWindowTokens: readOptionalPositiveInteger(parsed, configPath, "context_window_tokens", "contextWindowTokens"),
      openaiApiKey: readOptionalString(parsed, configPath, "openai_api_key", "openaiApiKey"),
      openrouterApiKey: readOptionalString(parsed, configPath, "openrouter_api_key", "openrouterApiKey"),
      codexAuthPath: readOptionalString(parsed, configPath, "codex_auth_path", "codexAuthPath"),
      parameters: readParameters(parsed, configPath),
    },
    found: true,
  }
}

async function readRawConfigMapping(configPath: string): Promise<Record<string, unknown>> {
  let raw: string
  try {
    raw = await readFile(configPath, "utf8")
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return {}
    throw error
  }

  const parsed = parse(raw)
  if (parsed == null) return {}
  if (!isRecord(parsed)) throw new Error(`Invalid Open Web Agent config at ${configPath}: expected a YAML mapping`)
  return parsed
}

function readParameters(record: Record<string, unknown>, configPath: string): ModelParameters | undefined {
  const value = readOptionalValue(record, "parameters", "model_parameters", "modelParameters")
  if (value == null) return undefined
  if (!isRecord(value)) throw new Error(`Invalid Open Web Agent config at ${configPath}: parameters must be a mapping`)

  return omitUndefined({
    temperature: readOptionalNumber(value, configPath, "temperature"),
    topP: readOptionalNumber(value, configPath, "top_p", "topP"),
    maxTokens: readOptionalInteger(value, configPath, "max_tokens", "maxTokens"),
    presencePenalty: readOptionalNumber(value, configPath, "presence_penalty", "presencePenalty"),
    frequencyPenalty: readOptionalNumber(value, configPath, "frequency_penalty", "frequencyPenalty"),
    seed: readOptionalInteger(value, configPath, "seed"),
    stop: readOptionalStop(value, configPath),
    extraBody: readOptionalRecord(value, configPath, "extra_body", "extraBody"),
  })
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

function readOptionalNumber(record: Record<string, unknown>, configPath: string, ...keys: string[]): number | undefined {
  const entry = readOptionalEntry(record, keys)
  if (!entry || entry.value == null) return undefined
  if (typeof entry.value !== "number") {
    throw new Error(`Invalid Open Web Agent config at ${configPath}: ${entry.key} must be a number`)
  }
  return entry.value
}

function readOptionalInteger(record: Record<string, unknown>, configPath: string, ...keys: string[]): number | undefined {
  const entry = readOptionalEntry(record, keys)
  if (!entry || entry.value == null) return undefined
  if (typeof entry.value !== "number" || !Number.isInteger(entry.value)) {
    throw new Error(`Invalid Open Web Agent config at ${configPath}: ${entry.key} must be an integer`)
  }
  return entry.value
}

function readOptionalPositiveInteger(record: Record<string, unknown>, configPath: string, ...keys: string[]): number | undefined {
  const entry = readOptionalEntry(record, keys)
  if (!entry || entry.value == null) return undefined
  if (typeof entry.value !== "number" || !Number.isInteger(entry.value) || entry.value <= 0) {
    throw new Error(`Invalid Open Web Agent config at ${configPath}: ${entry.key} must be a positive integer`)
  }
  return entry.value
}

function readOptionalRecord(
  record: Record<string, unknown>,
  configPath: string,
  ...keys: string[]
): Record<string, unknown> | undefined {
  const entry = readOptionalEntry(record, keys)
  if (!entry || entry.value == null) return undefined
  if (!isRecord(entry.value)) {
    throw new Error(`Invalid Open Web Agent config at ${configPath}: ${entry.key} must be a mapping`)
  }
  return entry.value
}

function readOptionalStop(record: Record<string, unknown>, configPath: string): string | string[] | undefined {
  const entry = readOptionalEntry(record, ["stop"])
  if (!entry || entry.value == null) return undefined
  if (typeof entry.value === "string") return entry.value
  if (Array.isArray(entry.value) && entry.value.every((item) => typeof item === "string") && entry.value.length > 0) {
    return entry.value
  }
  throw new Error(`Invalid Open Web Agent config at ${configPath}: stop must be a string or non-empty string array`)
}

function readOptionalValue(record: Record<string, unknown>, ...keys: string[]): unknown {
  return readOptionalEntry(record, keys)?.value
}

function readOptionalEntry(
  record: Record<string, unknown>,
  keys: string[],
): { key: string; value: unknown } | undefined {
  for (const key of keys) {
    if (key in record) return { key, value: record[key] }
  }
  return undefined
}

function omitUndefined<T extends Record<string, unknown>>(record: T): T {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined)) as T
}

function readContextWindowTokens(value: string | undefined): number | undefined {
  if (!value) return undefined
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error("Invalid OPEN_WEB_AGENT_CONTEXT_WINDOW_TOKENS: must be a positive integer")
  }
  return parsed
}

function expandHomePath(value: string): string {
  if (value === "~") return homedir()
  if (value.startsWith("~/")) return join(homedir(), value.slice(2))
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value != null && !Array.isArray(value)
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error
}

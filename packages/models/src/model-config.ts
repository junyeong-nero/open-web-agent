import { existsSync, readFileSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { resolveOwaHome } from "@open-web-agent/core"
import { parse, stringify } from "yaml"
import { resolveCodexAuthPath } from "./codex-auth"

export interface ModelConfig {
  defaultModel: string
  defaultModelProvider: string | null
  defaultAgentId: string | null
  defaultBrowserId: string | null
  browserHeadless: boolean
  browserPreventFocus: boolean
  reasoningEffort: string
  contextWindowTokens: number
  maxRetry: number
  openaiApiKey: string | null
  openrouterApiKey: string | null
  geminiApiKey: string | null
  anthropicApiKey: string | null
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
  homeDir?: string
}

export interface WriteModelSelectionConfigOptions {
  configPath?: string
  env?: NodeJS.ProcessEnv
  homeDir?: string
}

export interface ModelSelectionConfig {
  modelId: string
  modelName?: string | null
  reasoningEffort?: string | null
}

export interface AgentSelectionConfig {
  agentId: string
}

export interface BrowserSelectionConfig {
  browserId: string
}

export interface BrowserHeadlessConfig {
  browserHeadless: boolean
}

export type ModelProvider = "openai" | "openrouter" | "gemini" | "claude"

export const defaultOpenAIModel = "gpt-4.1-mini"
export const defaultOpenRouterModel = "nvidia/nemotron-3-super-120b-a12b:free"
export const defaultGeminiModel = "gemini-3.5-flash"
export const defaultClaudeModel = "claude-sonnet-4-6"

const defaultModel = defaultOpenRouterModel
const defaultReasoningEffort = "medium"
const defaultContextWindowTokens = 128000
const defaultMaxRetry = 0
const defaultBrowserHeadless = false
const defaultBrowserPreventFocus = false

export function resolveModelConfigPath(env: NodeJS.ProcessEnv = process.env, homeDir = homedir()): string {
  return join(resolveOwaHome(env, homeDir), "config.yaml")
}

export function readModelConfig(env: NodeJS.ProcessEnv = process.env, options: ReadModelConfigOptions = {}): ModelConfig {
  const homeDir = options.homeDir ?? homedir()
  const fileConfig = readConfigFile(options.configPath ?? resolveReadableModelConfigPath(env, homeDir))

  return {
    defaultModel: env.OPEN_WEB_AGENT_MODEL || fileConfig.defaultModel || defaultModel,
    defaultModelProvider: env.OPEN_WEB_AGENT_MODEL_PROVIDER || fileConfig.defaultModelProvider || null,
    defaultAgentId: env.OPEN_WEB_AGENT_AGENT || fileConfig.defaultAgentId || null,
    defaultBrowserId: env.OPEN_WEB_AGENT_BROWSER || fileConfig.defaultBrowserId || null,
    browserHeadless:
      readBooleanEnv(env.OPEN_WEB_AGENT_BROWSER_HEADLESS, "OPEN_WEB_AGENT_BROWSER_HEADLESS") ??
      fileConfig.browserHeadless ??
      defaultBrowserHeadless,
    browserPreventFocus:
      readBooleanEnv(env.OPEN_WEB_AGENT_BROWSER_PREVENT_FOCUS, "OPEN_WEB_AGENT_BROWSER_PREVENT_FOCUS") ??
      fileConfig.browserPreventFocus ??
      defaultBrowserPreventFocus,
    reasoningEffort: env.OPEN_WEB_AGENT_REASONING_EFFORT || fileConfig.reasoningEffort || defaultReasoningEffort,
    contextWindowTokens: readContextWindowTokens(env.OPEN_WEB_AGENT_CONTEXT_WINDOW_TOKENS) ?? fileConfig.contextWindowTokens ?? defaultContextWindowTokens,
    maxRetry: readMaxRetry(env.OPEN_WEB_AGENT_MAX_RETRY) ?? fileConfig.maxRetry ?? defaultMaxRetry,
    openaiApiKey: env.OPENAI_API_KEY || fileConfig.openaiApiKey || null,
    openrouterApiKey: env.OPENROUTER_API_KEY || fileConfig.openrouterApiKey || null,
    geminiApiKey: env.GEMINI_API_KEY || fileConfig.geminiApiKey || null,
    anthropicApiKey: env.ANTHROPIC_API_KEY || fileConfig.anthropicApiKey || null,
    codexAuthPath: expandHomePath(env.OPEN_WEB_AGENT_CODEX_AUTH_PATH || fileConfig.codexAuthPath || resolveCodexAuthPath(env.CODEX_HOME)),
    parameters: fileConfig.parameters ?? {},
  }
}

export function resolveProviderDefaultModel(provider: ModelProvider, defaultModel: string, defaultModelProvider?: string | null): string {
  const selectedProvider = parseModelProviderId(defaultModelProvider)
  if (selectedProvider && selectedProvider !== provider) return providerBuiltInDefaultModel(provider)
  if (provider === "openai" && defaultModel === defaultOpenRouterModel) return defaultOpenAIModel
  if (provider === "gemini" && defaultModel === defaultOpenRouterModel) return defaultGeminiModel
  if (provider === "claude" && defaultModel === defaultOpenRouterModel) return defaultClaudeModel
  return defaultModel
}

function parseModelProviderId(modelProvider: string | null | undefined): string | null {
  const provider = modelProvider?.split(":", 1)[0]?.trim().toLowerCase()
  if (!provider) return null
  return knownRuntimeModelProviders.has(provider) ? provider : null
}

function providerBuiltInDefaultModel(provider: ModelProvider): string {
  if (provider === "openai") return defaultOpenAIModel
  if (provider === "gemini") return defaultGeminiModel
  if (provider === "claude") return defaultClaudeModel
  return defaultOpenRouterModel
}

const knownRuntimeModelProviders = new Set(["openai", "openrouter", "gemini", "claude", "codex-oauth"])

export async function writeModelSelectionConfig(
  selection: ModelSelectionConfig,
  options: WriteModelSelectionConfigOptions = {},
): Promise<void> {
  const { readPath, writePath } = resolveWritableModelConfigPaths(options)
  const parsed = await readRawConfigMapping(readPath)
  const next = {
    ...parsed,
    model_provider: selection.modelId,
    ...(selection.modelName && selection.modelName.length > 0 ? { model: selection.modelName } : {}),
    ...(selection.reasoningEffort && selection.reasoningEffort.length > 0 ? { reasoning_effort: selection.reasoningEffort } : {}),
  }

  await mkdir(dirname(writePath), { recursive: true })
  await writeFile(writePath, stringify(next), "utf8")
}

export async function writeAgentSelectionConfig(
  selection: AgentSelectionConfig,
  options: WriteModelSelectionConfigOptions = {},
): Promise<void> {
  const { readPath, writePath } = resolveWritableModelConfigPaths(options)
  const parsed = await readRawConfigMapping(readPath)
  await writeConfigMapping(writePath, { ...parsed, agent: selection.agentId })
}

export async function writeBrowserSelectionConfig(
  selection: BrowserSelectionConfig,
  options: WriteModelSelectionConfigOptions = {},
): Promise<void> {
  const { readPath, writePath } = resolveWritableModelConfigPaths(options)
  const parsed = await readRawConfigMapping(readPath)
  await writeConfigMapping(writePath, { ...parsed, browser: selection.browserId })
}

export async function writeBrowserHeadlessConfig(
  selection: BrowserHeadlessConfig,
  options: WriteModelSelectionConfigOptions = {},
): Promise<void> {
  const { readPath, writePath } = resolveWritableModelConfigPaths(options)
  const parsed = await readRawConfigMapping(readPath)
  await writeConfigMapping(writePath, { ...parsed, browser_headless: selection.browserHeadless })
}

function resolveReadableModelConfigPath(env: NodeJS.ProcessEnv, homeDir: string): string {
  const configPath = resolveModelConfigPath(env, homeDir)
  if (hasConfiguredOwaHome(env) || existsSync(configPath)) return configPath
  return resolveExistingLegacyModelConfigPath(homeDir) ?? configPath
}

function resolveWritableModelConfigPaths(options: WriteModelSelectionConfigOptions): { readPath: string; writePath: string } {
  if (options.configPath) return { readPath: options.configPath, writePath: options.configPath }

  const env = options.env ?? process.env
  const homeDir = options.homeDir ?? homedir()
  return {
    readPath: resolveReadableModelConfigPath(env, homeDir),
    writePath: resolveModelConfigPath(env, homeDir),
  }
}

function resolveExistingLegacyModelConfigPath(homeDir: string): string | undefined {
  return resolveLegacyModelConfigPaths(homeDir).find((configPath) => existsSync(configPath))
}

function resolveLegacyModelConfigPaths(homeDir: string): string[] {
  return [join(homeDir, ".openwebagents", "config.yaml"), join(homeDir, ".openwebagent", "config.yaml")]
}

function hasConfiguredOwaHome(env: NodeJS.ProcessEnv): boolean {
  return env.OWA_HOME != null && env.OWA_HOME.length > 0
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
    defaultModelProvider: readOptionalString(parsed, configPath, "model_provider", "modelProvider"),
    defaultAgentId: readOptionalString(parsed, configPath, "agent", "agent_id", "default_agent", "defaultAgentId"),
    defaultBrowserId: readOptionalString(parsed, configPath, "browser", "browser_id", "environment_id", "default_browser", "defaultBrowserId"),
    browserHeadless: readOptionalBoolean(parsed, configPath, "browser_headless", "browserHeadless", "headless"),
    browserPreventFocus: readOptionalBoolean(parsed, configPath, "browser_prevent_focus", "browserPreventFocus", "prevent_browser_focus", "preventBrowserFocus"),
    reasoningEffort: readOptionalString(parsed, configPath, "reasoning_effort", "reasoningEffort"),
    contextWindowTokens: readOptionalPositiveInteger(parsed, configPath, "context_window_tokens", "contextWindowTokens"),
    maxRetry: readOptionalNonNegativeInteger(parsed, configPath, "max_retry", "maxRetry"),
    openaiApiKey: readOptionalString(parsed, configPath, "openai_api_key", "openaiApiKey"),
    openrouterApiKey: readOptionalString(parsed, configPath, "openrouter_api_key", "openrouterApiKey"),
    geminiApiKey: readOptionalString(parsed, configPath, "gemini_api_key", "geminiApiKey"),
    anthropicApiKey: readOptionalString(parsed, configPath, "anthropic_api_key", "anthropicApiKey"),
    codexAuthPath: readOptionalString(parsed, configPath, "codex_auth_path", "codexAuthPath"),
    parameters: readParameters(parsed, configPath),
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

async function writeConfigMapping(configPath: string, mapping: Record<string, unknown>): Promise<void> {
  await mkdir(dirname(configPath), { recursive: true })
  await writeFile(configPath, stringify(mapping), "utf8")
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

function readOptionalNonNegativeInteger(record: Record<string, unknown>, configPath: string, ...keys: string[]): number | undefined {
  const entry = readOptionalEntry(record, keys)
  if (!entry || entry.value == null) return undefined
  if (typeof entry.value !== "number" || !Number.isInteger(entry.value) || entry.value < 0) {
    throw new Error(`Invalid Open Web Agent config at ${configPath}: ${entry.key} must be a non-negative integer`)
  }
  return entry.value
}

function readOptionalBoolean(record: Record<string, unknown>, configPath: string, ...keys: string[]): boolean | undefined {
  const entry = readOptionalEntry(record, keys)
  if (!entry || entry.value == null) return undefined
  if (typeof entry.value !== "boolean") {
    throw new Error(`Invalid Open Web Agent config at ${configPath}: ${entry.key} must be a boolean`)
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

function readBooleanEnv(value: string | undefined, name: string): boolean | undefined {
  if (value == null || value.length === 0) return undefined
  const normalized = value.toLowerCase()
  if (["1", "true", "yes", "on"].includes(normalized)) return true
  if (["0", "false", "no", "off"].includes(normalized)) return false
  throw new Error(`Invalid ${name}: must be a boolean`)
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

function readMaxRetry(value: string | undefined): number | undefined {
  if (!value) return undefined
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error("Invalid OPEN_WEB_AGENT_MAX_RETRY: must be a non-negative integer")
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

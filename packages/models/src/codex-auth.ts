import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

export interface ReadCodexOAuthTokenOptions {
  authPath?: string
}

export function resolveCodexAuthPath(codexHome: string | undefined = undefined): string {
  return join(codexHome && codexHome.length > 0 ? codexHome : join(homedir(), ".codex"), "auth.json")
}

export function readCodexOAuthToken(
  env: NodeJS.ProcessEnv = process.env,
  options: ReadCodexOAuthTokenOptions = {},
): string | null {
  const envToken = readNonEmptyString(env.OPEN_WEB_AGENT_CODEX_ACCESS_TOKEN) ?? readNonEmptyString(env.CODEX_ACCESS_TOKEN)
  if (envToken) return envToken

  let raw: string
  try {
    raw = readFileSync(options.authPath ?? resolveCodexAuthPath(env.CODEX_HOME), "utf8")
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return null
    throw error
  }

  const parsed = JSON.parse(raw) as unknown
  if (!isRecord(parsed)) return null
  const tokens = parsed.tokens
  if (!isRecord(tokens)) return null
  return readNonEmptyString(tokens.access_token)
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error
}

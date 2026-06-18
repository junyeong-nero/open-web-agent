import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { resolveOwaHome } from "@open-web-agent/core"

const historyLimit = 100

export interface PromptHistoryOptions {
  home?: string
}

export interface PromptHistoryStore {
  load(): Promise<string[]>
  append(value: string): Promise<string[]>
}

export const defaultPromptHistoryStore: PromptHistoryStore = {
  load: () => loadPromptHistory(),
  append: (value) => appendPromptHistory(value),
}

export async function loadPromptHistory(options: PromptHistoryOptions = {}): Promise<string[]> {
  let raw: string
  try {
    raw = await readFile(promptHistoryPath(options), "utf8")
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return []
    throw error
  }

  const parsed = JSON.parse(raw) as unknown
  if (!Array.isArray(parsed)) return []

  return parsed.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0).slice(-historyLimit)
}

export async function appendPromptHistory(value: string, options: PromptHistoryOptions = {}): Promise<string[]> {
  const prompt = value.trim()
  const current = await loadPromptHistory(options)
  if (prompt.length === 0) return current

  const next = [...current.filter((entry) => entry !== prompt), prompt].slice(-historyLimit)
  const path = promptHistoryPath(options)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(next, null, 2)}\n`, "utf8")
  return next
}

function promptHistoryPath(options: PromptHistoryOptions): string {
  return join(options.home ?? resolveOwaHome(), "prompt-history.json")
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error
}

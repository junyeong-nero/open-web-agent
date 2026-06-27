import { readdirSync } from "node:fs"
import { join } from "node:path"
import { minimatch } from "minimatch"

export const Glob = {
  async scan(pattern: string, options: { cwd?: string; absolute?: boolean } = {}): Promise<string[]> {
    return scanSync(pattern, options)
  },
  scanSync,
  match(pattern: string, value: string): boolean {
    return minimatch(value, pattern, { dot: true })
  },
}

function scanSync(pattern: string, options: { cwd?: string; absolute?: boolean } = {}): string[] {
  const cwd = options.cwd ?? process.cwd()
  const entries = readdirSync(cwd, { recursive: true, withFileTypes: true })
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.parentPath ? join(entry.parentPath, entry.name) : entry.name)
    .filter((file) => minimatch(file, pattern, { dot: true }))
    .map((file) => (options.absolute ? join(cwd, file) : file))
}

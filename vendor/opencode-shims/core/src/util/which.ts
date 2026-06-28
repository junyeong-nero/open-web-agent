import { accessSync, constants } from "node:fs"
import { delimiter, join } from "node:path"

export function which(name: string): string | null {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    const candidate = join(directory, name)
    try {
      accessSync(candidate, constants.X_OK)
      return candidate
    } catch {
      // Try the next PATH entry.
    }
  }
  return null
}

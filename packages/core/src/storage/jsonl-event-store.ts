import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import { RunEventSchema, type RunEvent } from "../contracts/event"

export class JsonlEventStore {
  constructor(private readonly filePath: string) {}

  async append(event: RunEvent): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true })
    await writeFile(this.filePath, `${JSON.stringify(event)}\n`, { flag: "a" })
  }

  async readAll(): Promise<RunEvent[]> {
    const text = await readFile(this.filePath, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return ""
      throw error
    })

    return text
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => RunEventSchema.parse(JSON.parse(line)))
  }
}

import { appendFileSync, mkdirSync } from "node:fs"
import { dirname } from "node:path"
import type { AgentEvent } from "./agent"

/** Append every agent event to a JSONL file. Screenshot bytes are dropped to keep traces small. */
export function jsonlTrace(path: string): (event: AgentEvent) => void {
  mkdirSync(dirname(path), { recursive: true })
  return (event) => {
    const record =
      event.type === "tool" && event.result.image
        ? { ...event, result: { ...event.result, image: { mimeType: event.result.image.mimeType, bytes: event.result.image.data.length } } }
        : event
    appendFileSync(path, `${JSON.stringify({ time: new Date().toISOString(), ...record })}\n`)
  }
}

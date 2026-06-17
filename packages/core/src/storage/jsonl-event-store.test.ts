import { describe, expect, it } from "bun:test"
import { mkdtemp, readFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import type { RunEvent } from "../contracts/event"
import { JsonlEventStore } from "./jsonl-event-store"

function event(sequence: number, type: RunEvent["type"] = "run.started"): RunEvent {
  return {
    id: `evt_${sequence}`,
    runId: "run_1",
    sessionId: "ses_1",
    stepId: null,
    sequence,
    type,
    payload: { sequence },
    createdAt: "2026-06-17T00:00:00.000Z",
  }
}

describe("JsonlEventStore", () => {
  it("appends and reads run events", async () => {
    const directory = await mkdtemp(join(tmpdir(), "owa-jsonl-"))
    const filePath = join(directory, "nested", "events.jsonl")
    const store = new JsonlEventStore(filePath)

    await store.append(event(0))
    await store.append(event(1, "run.completed"))

    const raw = await readFile(filePath, "utf8")
    expect(raw).toBe(`${JSON.stringify(event(0))}\n${JSON.stringify(event(1, "run.completed"))}\n`)
    expect(await store.readAll()).toEqual([event(0), event(1, "run.completed")])
  })
})

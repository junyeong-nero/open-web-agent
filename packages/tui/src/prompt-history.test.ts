import { describe, expect, it } from "bun:test"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { appendPromptHistory, loadPromptHistory } from "./prompt-history"

describe("prompt history", () => {
  it("persists submitted prompts globally under OWA_HOME", async () => {
    const home = await mkdtemp(join(tmpdir(), "owa-prompt-history-"))

    expect(await loadPromptHistory({ home })).toEqual([])

    expect(await appendPromptHistory("first prompt", { home })).toEqual(["first prompt"])
    expect(await appendPromptHistory("second prompt", { home })).toEqual(["first prompt", "second prompt"])

    expect(await loadPromptHistory({ home })).toEqual(["first prompt", "second prompt"])
  })

  it("deduplicates repeated prompts while keeping the most recent entry last", async () => {
    const home = await mkdtemp(join(tmpdir(), "owa-prompt-history-"))

    await appendPromptHistory("first prompt", { home })
    await appendPromptHistory("second prompt", { home })
    await appendPromptHistory("first prompt", { home })

    expect(await loadPromptHistory({ home })).toEqual(["second prompt", "first prompt"])
  })
})

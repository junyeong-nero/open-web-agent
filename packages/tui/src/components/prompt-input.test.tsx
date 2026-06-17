/** @jsxImportSource @opentui/solid */
import { describe, expect, it } from "bun:test"
import { testRender } from "@opentui/solid"
import type { ModelActivity } from "../state/types"
import { getTheme } from "../theme/themes"
import { PromptInput } from "./prompt-input"

const idleActivity: ModelActivity = {
  status: "idle",
  modelId: null,
  modelName: null,
  provider: null,
  reasoningEffort: null,
  contextWindowTokens: 128000,
  usage: null,
}

describe("PromptInput", () => {
  it("renders agent, model, effort metadata with a blank row after the input", async () => {
    const setup = await testRender(
      () => (
        <PromptInput
          value=""
          agent={{ id: "plan-act-agent", name: "PlanAct Agent", description: "Plans before acting." }}
          model={{
            id: "openai",
            name: "OpenAI",
            provider: "openai",
            modelName: "GPT-5.5",
            reasoningEffort: "xhigh",
          }}
          modelActivity={idleActivity}
          runStatus="idle"
          theme={getTheme("opencode")}
          onChange={() => {}}
          onSubmit={() => {}}
        />
      ),
      { width: 80, height: 8 },
    )

    try {
      await setup.flush()
      const rows = setup.captureCharFrame().split("\n")
      const placeholderRow = rows.findIndex((row) => row.includes("Ask anything"))
      const metadataRow = rows.findIndex((row) => row.includes("PlanAct / GPT-5.5 / xhigh"))

      expect(metadataRow).toBeGreaterThan(placeholderRow + 1)
      expect(rows[metadataRow - 1]?.trim()).toBe("")
      expect(rows.join("\n")).not.toContain("Build ·")
    } finally {
      setup.renderer.destroy()
    }
  })
})

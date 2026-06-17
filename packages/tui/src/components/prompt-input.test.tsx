/** @jsxImportSource @opentui/solid */
import { describe, expect, it } from "bun:test"
import { TextareaRenderable } from "@opentui/core"
import { testRender } from "@opentui/solid"
import type { ModelActivity } from "../state/types"
import { getTheme } from "../theme/themes"
import { PromptInput } from "./prompt-input"

const idleModelActivity: ModelActivity = {
  status: "idle",
  modelId: null,
  modelName: null,
  provider: null,
  reasoningEffort: null,
  contextWindowTokens: null,
  usage: null,
}

describe("PromptInput", () => {
  it("autocompletes the displayed slash command suggestion on tab", async () => {
    const changes: string[] = []
    const setup = await testRender(
      () => (
        <PromptInput
          value="/ag"
          model={null}
          modelActivity={idleModelActivity}
          runStatus="idle"
          theme={getTheme("opencode")}
          onChange={(value) => changes.push(value)}
          onSubmit={() => {}}
        />
      ),
      { width: 80, height: 12 },
    )

    try {
      await setup.flush()
      changes.length = 0
      const textarea = setup.renderer.root.findDescendantById("prompt-input-textarea")

      expect(textarea).toBeInstanceOf(TextareaRenderable)

      setup.mockInput.pressTab()
      await setup.flush()

      expect((textarea as TextareaRenderable).plainText).toBe("/agent ")
      expect(changes).toEqual(["/agent "])
    } finally {
      setup.renderer.destroy()
    }
  })
})

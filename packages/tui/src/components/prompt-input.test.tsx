/** @jsxImportSource @opentui/solid */
import { describe, expect, it } from "bun:test"
import { BoxRenderable, TextareaRenderable } from "@opentui/core"
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
  contextWindowTokens: 128000,
  usage: null,
}

describe("PromptInput", () => {
  it("autocompletes the displayed slash command suggestion on tab", async () => {
    const changes: string[] = []
    const setup = await testRender(
      () => (
        <PromptInput
          value="/ag"
          agent={null}
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

  it("moves slash command selection with arrow keys before completing", async () => {
    const changes: string[] = []
    const setup = await testRender(
      () => (
        <PromptInput
          value="/"
          agent={null}
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

      setup.mockInput.pressArrow("down")
      setup.mockInput.pressTab()
      await setup.flush()

      expect((textarea as TextareaRenderable).plainText).toBe("/clear")
      expect(changes).toEqual(["/clear"])
    } finally {
      setup.renderer.destroy()
    }
  })

  it("lets the mouse cursor choose a slash command suggestion", async () => {
    const changes: string[] = []
    const setup = await testRender(
      () => (
        <PromptInput
          value="/"
          agent={null}
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
      const detailsSuggestion = setup.renderer.root.findDescendantById("slash-suggestion-2")

      expect(textarea).toBeInstanceOf(TextareaRenderable)
      expect(detailsSuggestion).toBeInstanceOf(BoxRenderable)

      await setup.mockMouse.click((detailsSuggestion as BoxRenderable).screenX + 1, (detailsSuggestion as BoxRenderable).screenY)
      await setup.flush()

      expect((textarea as TextareaRenderable).plainText).toBe("/details")
      expect(changes).toEqual(["/details"])
    } finally {
      setup.renderer.destroy()
    }
  })

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
          modelActivity={idleModelActivity}
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

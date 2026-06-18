/** @jsxImportSource @opentui/solid */
import { describe, expect, it } from "bun:test"
import { testRender } from "@opentui/solid"
import type { ModelSummary } from "../state/types"
import { getTheme } from "../theme/themes"
import { buildModelSelectorSections, ModelSelector } from "./model-selector"

const models: ModelSummary[] = [
  { id: "openai", name: "OpenAI", provider: "openai", modelName: "GPT-5.5" },
  { id: "openrouter-claude", name: "OpenRouter", provider: "openrouter", modelName: "Claude Opus 4.6" },
  { id: "openrouter-free", name: "OpenRouter", provider: "openrouter", modelName: "DeepSeek V4 Flash Free" },
]

describe("buildModelSelectorSections", () => {
  it("groups the selected model as a favorite and filters by searchable metadata", () => {
    expect(buildModelSelectorSections(models, "openai", "").map((section) => section.title)).toEqual(["Favorites", "OpenRouter"])
    expect(buildModelSelectorSections(models, "openai", "claude")).toEqual([
      {
        title: "OpenRouter",
        options: [
          {
            id: "openrouter-claude",
            label: "Claude Opus 4.6",
            detail: "OpenRouter",
            selected: false,
          },
        ],
      },
    ])
  })

  it("groups models by provider even when names differ", () => {
    const providerModels: ModelSummary[] = [
      { id: "openai:gpt-5.5", name: "GPT-5.5", provider: "openai", modelName: "gpt-5.5" },
      { id: "openai:gpt-5.4", name: "GPT-5.4", provider: "openai", modelName: "gpt-5.4" },
      { id: "openrouter:claude", name: "Claude Opus", provider: "openrouter", modelName: "anthropic/claude-opus" },
    ]

    expect(buildModelSelectorSections(providerModels, null, "").map((section) => section.title)).toEqual(["OpenAI", "OpenRouter"])
    expect(buildModelSelectorSections(providerModels, null, "")[0]?.options.map((option) => option.id)).toEqual([
      "openai:gpt-5.5",
      "openai:gpt-5.4",
    ])
  })
})

describe("ModelSelector", () => {
  it("renders a centered model picker with search, sections, selected marker, and footer shortcuts", async () => {
    const setup = await testRender(
      () => (
        <ModelSelector
          models={models}
          selectedModelId="openai"
          theme={getTheme("opencode")}
          onSelect={() => {}}
          onCancel={() => {}}
        />
      ),
      { width: 96, height: 24 },
    )

    try {
      await setup.flush()
      const frame = setup.captureCharFrame()

      expect(frame).toContain("Select model")
      expect(frame).toContain("esc")
      expect(frame).toContain("Search")
      expect(frame).toContain("Favorites")
      expect(frame).toContain("● GPT-5.5 OpenAI")
      expect(frame).toContain("OpenRouter")
      expect(frame).toContain("Claude Opus 4.6")
      expect(frame).toContain("Select enter")
      expect(frame).toContain("Close esc")
    } finally {
      setup.renderer.destroy()
    }
  })

  it("moves the highlighted row and selects it with enter", async () => {
    const selected: string[] = []
    const setup = await testRender(
      () => (
        <ModelSelector
          models={models}
          selectedModelId="openai"
          theme={getTheme("opencode")}
          onSelect={(modelId) => selected.push(modelId)}
          onCancel={() => {}}
        />
      ),
      { width: 96, height: 24 },
    )

    try {
      await setup.flush()
      setup.mockInput.pressArrow("down")
      await setup.flush()

      setup.mockInput.pressEnter()
      await setup.flush()

      expect(selected).toEqual(["openrouter-claude"])
    } finally {
      setup.renderer.destroy()
    }
  })
})

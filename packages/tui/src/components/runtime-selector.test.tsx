/** @jsxImportSource @opentui/solid */
import { describe, expect, it } from "bun:test"
import { testRender } from "@opentui/solid"
import type { AgentSummary, EnvironmentSummary, ModelSummary } from "../state/types"
import { getTheme } from "../theme/themes"
import {
  buildAgentSelectorSections,
  buildBrowserSelectorSections,
  buildModelSelectorSections,
  RuntimeSelector,
  type RuntimeSelectorOption,
} from "./runtime-selector"

const models: ModelSummary[] = [
  { id: "openai", name: "OpenAI", provider: "openai", modelName: "GPT-5.5" },
  { id: "openrouter-claude", name: "OpenRouter", provider: "openrouter", modelName: "Claude Opus 4.6" },
  { id: "openrouter-free", name: "OpenRouter", provider: "openrouter", modelName: "DeepSeek V4 Flash Free" },
]

const agents: AgentSummary[] = [
  { id: "see-act", name: "SeeAct", description: "Visual grounding agent" },
  { id: "plan-act-agent", name: "PlanAct", description: "Plans before acting" },
]

const browsers: EnvironmentSummary[] = [
  { id: "mock-browser", name: "Mock Browser" },
  { id: "playwright-browser", name: "Playwright Browser" },
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

  it("sorts provider sections independently of runtime registration order", () => {
    const providerModels: ModelSummary[] = [
      {
        id: "openrouter:nvidia/nemotron-3-super-120b-a12b:free",
        name: "OpenRouter",
        provider: "openrouter",
        modelName: "nvidia/nemotron-3-super-120b-a12b:free",
      },
      { id: "openrouter:openai/gpt-5.5", name: "OpenRouter", provider: "openrouter", modelName: "openai/gpt-5.5" },
      { id: "openai", name: "OpenAI", provider: "openai", modelName: "gpt-5.5" },
      { id: "gemini", name: "Gemini", provider: "gemini", modelName: "gemini-3.5-flash" },
      { id: "openrouter:google/gemini-3.5-flash", name: "OpenRouter", provider: "openrouter", modelName: "google/gemini-3.5-flash" },
    ]

    const sections = buildModelSelectorSections(providerModels, "openrouter:nvidia/nemotron-3-super-120b-a12b:free", "")

    expect(sections.map((section) => section.title)).toEqual(["Favorites", "OpenAI", "Gemini", "OpenRouter"])
    expect(sections.at(-1)?.options.map((option) => option.id)).toEqual([
      "openrouter:openai/gpt-5.5",
      "openrouter:google/gemini-3.5-flash",
    ])
  })

  it("uses the requested provider labels and marks free models in the option detail", () => {
    const providerModels: ModelSummary[] = [
      { id: "openai:gpt-5.5", name: "OpenAI", provider: "openai", modelName: "gpt-5.5" },
      { id: "claude", name: "Claude", provider: "claude", modelName: "claude-sonnet-4-6" },
      { id: "gemini", name: "Gemini", provider: "gemini", modelName: "gemini-3.5-flash" },
      { id: "codex-oauth", name: "Codex OAuth", provider: "codex-oauth", modelName: "gpt-5.5" },
      {
        id: "openrouter:nvidia/nemotron-3-super-120b-a12b:free",
        name: "OpenRouter",
        provider: "openrouter",
        modelName: "nvidia/nemotron-3-super-120b-a12b:free",
      },
    ]

    const sections = buildModelSelectorSections(providerModels, null, "")

    expect(sections.map((section) => section.title)).toEqual(["OpenAI", "Claude", "Gemini", "OpenAI OAuth", "OpenRouter"])
    expect(sections.at(-1)?.options).toEqual([
      {
        id: "openrouter:nvidia/nemotron-3-super-120b-a12b:free",
        label: "nvidia/nemotron-3-super-120b-a12b:free",
        detail: "Free",
        selected: false,
      },
    ])
  })
})

describe("buildAgentSelectorSections", () => {
  it("groups the selected agent as a favorite and filters by id, name, and description", () => {
    expect(buildAgentSelectorSections(agents, "see-act", "").map((section) => section.title)).toEqual(["Favorites", "Agents"])
    expect(buildAgentSelectorSections(agents, "see-act", "plans")).toEqual([
      {
        title: "Agents",
        options: [
          {
            id: "plan-act-agent",
            label: "PlanAct",
            detail: "Plans before acting",
            selected: false,
          },
        ],
      },
    ])
  })
})

describe("buildBrowserSelectorSections", () => {
  it("groups the selected browser as a favorite and filters by id or name", () => {
    expect(buildBrowserSelectorSections(browsers, "playwright-browser", "").map((section) => section.title)).toEqual(["Favorites", "Browsers"])
    expect(buildBrowserSelectorSections(browsers, "playwright-browser", "mock")).toEqual([
      {
        title: "Browsers",
        options: [
          {
            id: "mock-browser",
            label: "Mock Browser",
            detail: "mock-browser",
            selected: false,
          },
        ],
      },
    ])
  })
})

describe("RuntimeSelector", () => {
  const sections = [
    {
      title: "Favorites",
      options: [{ id: "openai", label: "GPT-5.5", detail: "OpenAI", selected: true }],
    },
    {
      title: "OpenRouter",
      options: [{ id: "openrouter-free", label: "nvidia/nemotron-3-super-120b-a12b:free", detail: "Free", selected: false }],
    },
  ]

  it("renders a centered picker with search, sections, selected marker, and footer shortcuts", async () => {
    const setup = await testRender(
      () => (
        <RuntimeSelector
          title="Select model"
          emptyMessage="No matching models"
          sections={sections}
          theme={getTheme("opencode")}
          onQueryChange={() => {}}
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
      expect(frame).toContain("nvidia/nemotron-3-super-120b-a12b:free")
      const freeModelLine = frame.split("\n").find((line) => line.includes("nvidia/nemotron-3-super-120b-a12b:free"))
      expect(freeModelLine?.trimEnd()).toEndWith("Free")
      expect(freeModelLine).toMatch(/:free\s{2,}Free/)
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
        <RuntimeSelector
          title="Select model"
          emptyMessage="No matching models"
          sections={sections}
          theme={getTheme("opencode")}
          onQueryChange={() => {}}
          onSelect={(option: RuntimeSelectorOption) => selected.push(option.id)}
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

      expect(selected).toEqual(["openrouter-free"])
    } finally {
      setup.renderer.destroy()
    }
  })
})

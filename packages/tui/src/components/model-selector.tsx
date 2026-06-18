/** @jsxImportSource @opentui/solid */
import { createMemo, createSignal, For } from "solid-js"
import type { InputRenderable, KeyEvent } from "@opentui/core"
import type { ModelSummary } from "../state/types"
import type { TuiTheme } from "../theme/themes"

export interface ModelSelectorOption {
  id: string
  label: string
  detail: string
  selected: boolean
}

export interface ModelSelectorSection {
  title: string
  options: ModelSelectorOption[]
}

interface ModelSelectorRow {
  kind: "section" | "option" | "empty"
  title?: string
  option?: ModelSelectorOption
  optionIndex?: number
}

export interface ModelSelectorProps {
  models: ModelSummary[]
  selectedModelId: string | null
  theme: TuiTheme
  onSelect(modelId: string): void
  onCancel(): void
}

export function ModelSelector(props: ModelSelectorProps) {
  const attachedSearchInputs = new WeakSet<InputRenderable>()
  const [query, setQuery] = createSignal("")
  const [highlightIndex, setHighlightIndex] = createSignal(0)
  const sections = createMemo(() => buildModelSelectorSections(props.models, props.selectedModelId, query()))
  const options = createMemo(() => sections().flatMap((section) => section.options))
  const rows = createMemo(() => buildModelSelectorRows(sections()))
  const boundedHighlightIndex = () => clamp(highlightIndex(), 0, Math.max(0, options().length - 1))
  const highlightedOption = () => options()[boundedHighlightIndex()]

  const updateQuery = (value: string) => {
    setQuery(value)
    setHighlightIndex(0)
  }
  const moveHighlight = (delta: number) => {
    const count = options().length
    if (count === 0) return
    setHighlightIndex((index) => (index + delta + count) % count)
  }

  const selectHighlighted = () => {
    const option = highlightedOption()
    if (option) props.onSelect(option.id)
  }

  const handleKeyDown = (event: KeyEvent) => {
    if (event.name === "escape") {
      event.preventDefault()
      props.onCancel()
      return
    }

    if (event.name === "return" || event.name === "enter" || event.name === "linefeed") {
      event.preventDefault()
      selectHighlighted()
      return
    }

    if (event.name === "up") {
      event.preventDefault()
      moveHighlight(-1)
      return
    }

    if (event.name === "down") {
      event.preventDefault()
      moveHighlight(1)
    }
  }

  const attachSearchInput = (node: InputRenderable) => {
    if (attachedSearchInputs.has(node)) return
    attachedSearchInputs.add(node)

    const syncQuery = () => updateQuery(node.value)
    node.on("input", syncQuery)
    node.on("change", syncQuery)
    node.on("enter", selectHighlighted)
  }

  return (
    <box
      id="model-selector-overlay"
      position="absolute"
      top={0}
      left={0}
      width="100%"
      height="100%"
      zIndex={50}
      alignItems="center"
      justifyContent="center"
      backgroundColor={props.theme.surface}
    >
      <box
        id="model-selector"
        flexDirection="column"
        width={64}
        minHeight={15}
        maxHeight={22}
        paddingX={2}
        paddingY={1}
        backgroundColor={props.theme.panel}
      >
        <box flexDirection="row" justifyContent="space-between" paddingBottom={1}>
          <text fg={props.theme.text} wrapMode="none">
            Select model
          </text>
          <text fg={props.theme.textMuted} wrapMode="none">
            esc
          </text>
        </box>
        <input
          id="model-selector-search"
          ref={(node) => attachSearchInput(node as InputRenderable)}
          focused
          value={query()}
          placeholder="Search"
          backgroundColor={props.theme.panel}
          textColor={props.theme.text}
          focusedBackgroundColor={props.theme.panel}
          focusedTextColor={props.theme.text}
          placeholderColor={props.theme.textMuted}
          onKeyDown={handleKeyDown}
        />
        <box flexDirection="column" paddingTop={1} paddingBottom={1}>
          <For each={rows()}>
            {(row) => {
              if (row.kind === "empty") {
                return (
                  <box paddingY={1}>
                    <text fg={props.theme.textMuted} wrapMode="none">
                      No matching models
                    </text>
                  </box>
                )
              }

              if (row.kind === "section") {
                return (
                  <box paddingTop={1}>
                    <text fg={props.theme.tool} wrapMode="none">
                      {row.title}
                    </text>
                  </box>
                )
              }

              const selected = () => row.optionIndex === boundedHighlightIndex()
              return (
                <box
                  flexDirection="row"
                  justifyContent="space-between"
                  paddingX={1}
                  backgroundColor={selected() ? props.theme.task : props.theme.panel}
                >
                  <text fg={selected() ? props.theme.surface : props.theme.text} wrapMode="none">
                    {`${row.option?.selected ? "●" : " "} ${row.option?.label ?? ""} ${row.option?.detail ?? ""}`}
                  </text>
                </box>
              )
            }}
          </For>
        </box>
        <box flexDirection="row" gap={2} paddingTop={1}>
          <text fg={props.theme.textMuted} wrapMode="none">
            Select enter
          </text>
          <text fg={props.theme.textMuted} wrapMode="none">
            Close esc
          </text>
        </box>
      </box>
    </box>
  )
}

export function buildModelSelectorSections(models: ModelSummary[], selectedModelId: string | null, query: string): ModelSelectorSection[] {
  const normalizedQuery = query.trim().toLowerCase()
  const selectedModel = models.find((model) => model.id === selectedModelId)
  const matches = (model: ModelSummary) => {
    if (normalizedQuery.length === 0) return true
    return [model.id, model.name, model.provider, model.modelName]
      .filter((value): value is string => typeof value === "string")
      .some((value) => value.toLowerCase().includes(normalizedQuery))
  }

  const sections: ModelSelectorSection[] = []
  if (selectedModel && normalizedQuery.length === 0) {
    sections.push({ title: "Favorites", options: [toModelSelectorOption(selectedModel, true)] })
  }

  const grouped = new Map<string, ModelSelectorOption[]>()
  for (const model of models) {
    if (model.id === selectedModelId && normalizedQuery.length === 0) continue
    if (!matches(model)) continue

    const title = providerDisplayName(model)
    const options = grouped.get(title) ?? []
    options.push(toModelSelectorOption(model, model.id === selectedModelId))
    grouped.set(title, options)
  }

  for (const [title, options] of grouped) {
    sections.push({ title, options })
  }

  return sections.filter((section) => section.options.length > 0)
}

function buildModelSelectorRows(sections: ModelSelectorSection[]): ModelSelectorRow[] {
  if (sections.length === 0) return [{ kind: "empty" }]

  let optionIndex = 0
  const rows: ModelSelectorRow[] = []
  for (const section of sections) {
    rows.push({ kind: "section", title: section.title })
    for (const option of section.options) {
      rows.push({ kind: "option", option, optionIndex })
      optionIndex += 1
    }
  }
  return rows
}

function toModelSelectorOption(model: ModelSummary, selected: boolean): ModelSelectorOption {
  return {
    id: model.id,
    label: model.modelName ?? model.name ?? model.id,
    detail: providerDisplayName(model),
    selected,
  }
}

function providerDisplayName(model: ModelSummary): string {
  if (model.provider.length === 0) return model.id
  const knownProviderName = providerDisplayNames[model.provider.toLowerCase()]
  if (knownProviderName) return knownProviderName
  return model.provider
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(" ")
}

const providerDisplayNames: Record<string, string> = {
  claude: "Claude",
  gemini: "Gemini",
  openai: "OpenAI",
  openrouter: "OpenRouter",
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

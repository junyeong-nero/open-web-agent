/** @jsxImportSource @opentui/solid */
import { For, createMemo, createSignal } from "solid-js"
import type { InputRenderable, KeyEvent } from "@opentui/core"
import { useKeyboard } from "@opentui/solid"
import type { AgentSummary, EnvironmentSummary, ModelSummary } from "../state/types"
import type { TuiTheme } from "../theme/themes"

export interface RuntimeSelectorOption {
  id: string
  label: string
  detail: string
  selected: boolean
}

export interface RuntimeSelectorSection {
  title: string
  options: RuntimeSelectorOption[]
}

interface RuntimeSelectorRow {
  kind: "section" | "option" | "empty"
  title?: string
  option?: RuntimeSelectorOption
  optionIndex?: number
}

export interface RuntimeSelectorProps {
  title: string
  emptyMessage: string
  sections: RuntimeSelectorSection[]
  theme: TuiTheme
  onQueryChange(query: string): void
  onSelect(option: RuntimeSelectorOption): void
  onCancel(): void
}

export function RuntimeSelector(props: RuntimeSelectorProps) {
  const attachedSearchInputs = new WeakSet<InputRenderable>()
  const [query, setQuery] = createSignal("")
  const [highlightIndex, setHighlightIndex] = createSignal(0)
  const options = createMemo(() => props.sections.flatMap((section) => section.options))
  const rows = createMemo(() => buildRuntimeSelectorRows(props.sections))
  const boundedHighlightIndex = () => clamp(highlightIndex(), 0, Math.max(0, options().length - 1))
  const highlightedOption = () => options()[boundedHighlightIndex()]

  const updateQuery = (value: string) => {
    setQuery(value)
    props.onQueryChange(value)
    setHighlightIndex(0)
  }
  const moveHighlight = (delta: number) => {
    const count = options().length
    if (count === 0) return
    setHighlightIndex((index) => (index + delta + count) % count)
  }

  const selectHighlighted = () => {
    const option = highlightedOption()
    if (option) props.onSelect(option)
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
    node.onKeyDown = handleKeyDown
  }

  useKeyboard(handleKeyDown)

  return (
    <box
      id="runtime-selector-overlay"
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
        id="runtime-selector"
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
            {props.title}
          </text>
          <text fg={props.theme.textMuted} wrapMode="none">
            esc
          </text>
        </box>
        <input
          id="runtime-selector-search"
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
                      {props.emptyMessage}
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

export function buildModelSelectorSections(models: ModelSummary[], selectedModelId: string | null, query: string): RuntimeSelectorSection[] {
  const normalizedQuery = query.trim().toLowerCase()
  const selectedModel = models.find((model) => model.id === selectedModelId)
  const matches = (model: ModelSummary) => {
    if (normalizedQuery.length === 0) return true
    return [model.id, model.name, model.provider, model.modelName]
      .filter((value): value is string => typeof value === "string")
      .some((value) => value.toLowerCase().includes(normalizedQuery))
  }

  const sections: RuntimeSelectorSection[] = []
  if (selectedModel && normalizedQuery.length === 0) {
    sections.push({ title: "Favorites", options: [toModelSelectorOption(selectedModel, true)] })
  }

  const grouped = new Map<string, RuntimeSelectorOption[]>()
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

export function buildAgentSelectorSections(agents: AgentSummary[], selectedAgentId: string, query: string): RuntimeSelectorSection[] {
  return buildSimpleSelectorSections({
    items: agents,
    selectedId: selectedAgentId,
    groupTitle: "Agents",
    query,
    toOption: (agent, selected) => ({
      id: agent.id,
      label: displayValue(agent.name, agent.id),
      detail: displayValue(agent.description, agent.id),
      selected,
    }),
    searchable: (agent) => [agent.id, agent.name, agent.description],
  })
}

export function buildBrowserSelectorSections(
  environments: EnvironmentSummary[],
  selectedEnvironmentId: string,
  query: string,
): RuntimeSelectorSection[] {
  return buildSimpleSelectorSections({
    items: environments,
    selectedId: selectedEnvironmentId,
    groupTitle: "Browsers",
    query,
    toOption: (environment, selected) => ({
      id: environment.id,
      label: displayValue(environment.name, environment.id),
      detail: environment.id,
      selected,
    }),
    searchable: (environment) => [environment.id, environment.name],
  })
}

function buildSimpleSelectorSections<T extends { id: string }>(options: {
  items: T[]
  selectedId: string
  groupTitle: string
  query: string
  toOption(item: T, selected: boolean): RuntimeSelectorOption
  searchable(item: T): Array<string | null | undefined>
}): RuntimeSelectorSection[] {
  const normalizedQuery = options.query.trim().toLowerCase()
  const selectedItem = options.items.find((item) => item.id === options.selectedId)
  const matches = (item: T) => {
    if (normalizedQuery.length === 0) return true
    return options
      .searchable(item)
      .filter((value): value is string => typeof value === "string")
      .some((value) => value.toLowerCase().includes(normalizedQuery))
  }

  const sections: RuntimeSelectorSection[] = []
  if (selectedItem && normalizedQuery.length === 0) {
    sections.push({ title: "Favorites", options: [options.toOption(selectedItem, true)] })
  }

  const itemOptions = options.items
    .filter((item) => !(item.id === options.selectedId && normalizedQuery.length === 0))
    .filter(matches)
    .map((item) => options.toOption(item, item.id === options.selectedId))

  if (itemOptions.length > 0) sections.push({ title: options.groupTitle, options: itemOptions })
  return sections
}

function buildRuntimeSelectorRows(sections: RuntimeSelectorSection[]): RuntimeSelectorRow[] {
  if (sections.length === 0) return [{ kind: "empty" }]

  let optionIndex = 0
  const rows: RuntimeSelectorRow[] = []
  for (const section of sections) {
    rows.push({ kind: "section", title: section.title })
    for (const option of section.options) {
      rows.push({ kind: "option", option, optionIndex })
      optionIndex += 1
    }
  }
  return rows
}

function toModelSelectorOption(model: ModelSummary, selected: boolean): RuntimeSelectorOption {
  return {
    id: model.id,
    label: model.modelName ?? model.name ?? model.id,
    detail: providerDisplayName(model),
    selected,
  }
}

function providerDisplayName(model: ModelSummary): string {
  if (model.name) return model.name
  if (model.provider.length === 0) return model.id
  return model.provider
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(" ")
}

function displayValue(value: string | null | undefined, fallback: string): string {
  const trimmed = value?.trim()
  return trimmed && trimmed.length > 0 ? trimmed : fallback
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

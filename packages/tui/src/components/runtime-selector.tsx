/** @jsxImportSource @opentui/solid */
import { For, createMemo, createSignal } from "solid-js"
import type { InputRenderable, KeyEvent, ScrollBoxRenderable } from "@opentui/core"
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

interface ModelSelectorGroup {
  provider: string
  title: string
  options: RuntimeSelectorOption[]
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
  let optionsScroll: ScrollBoxRenderable | undefined
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
    optionsScroll?.scrollTo(0)
  }
  const moveHighlight = (delta: number) => {
    const count = options().length
    if (count === 0) return
    let nextIndex = 0
    setHighlightIndex((index) => {
      nextIndex = (index + delta + count) % count
      return nextIndex
    })
    scrollOptionIntoView(nextIndex)
  }

  const scrollOptionIntoView = (optionIndex: number) => {
    if (!optionsScroll) return

    const rowIndex = rows().findIndex((row) => row.kind === "option" && row.optionIndex === optionIndex)
    if (rowIndex < 0) return

    const viewportHeight = Math.max(1, optionsScroll.viewport.height)
    const scrollTop = optionsScroll.scrollTop
    if (rowIndex < scrollTop) {
      optionsScroll.scrollTo(rowIndex)
      return
    }
    if (rowIndex >= scrollTop + viewportHeight) {
      optionsScroll.scrollTo(rowIndex - viewportHeight + 1)
    }
  }

  const selectHighlighted = () => {
    const option = highlightedOption()
    if (option) props.onSelect(option)
  }

  const cancel = (event: KeyEvent) => {
    if (event.name === "escape" || event.name === "esc" || event.sequence === "\u001b") {
      event.preventDefault()
      event.stopPropagation()
      props.onCancel()
      return true
    }
    return false
  }

  useKeyboard(cancel)

  const handleKeyDown = (event: KeyEvent) => {
    if (cancel(event)) return

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
        <scrollbox
          id="runtime-selector-options"
          ref={(node) => {
            optionsScroll = node as ScrollBoxRenderable
          }}
          height={13}
          backgroundColor={props.theme.panel}
          scrollY={true}
          scrollX={false}
          viewportCulling={true}
          contentOptions={{ flexDirection: "column", paddingTop: 1, paddingBottom: 1 }}
        >
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
              const detail = () => row.option?.detail ?? ""
              const endDetail = () => (detail() === freeModelBadge ? detail() : "")
              const inlineDetail = () => {
                const value = detail()
                return value.length > 0 && value !== freeModelBadge ? ` ${value}` : ""
              }
              return (
                <box
                  id={runtimeSelectorOptionRowId(row.optionIndex ?? 0)}
                  flexDirection="row"
                  justifyContent="space-between"
                  paddingX={1}
                  backgroundColor={selected() ? props.theme.task : props.theme.panel}
                >
                  <text fg={selected() ? props.theme.surface : props.theme.text} wrapMode="none">
                    {`${row.option?.selected ? "●" : " "} ${row.option?.label ?? ""}${inlineDetail()}`}
                  </text>
                  <text visible={endDetail().length > 0} fg={selected() ? props.theme.surface : props.theme.textMuted} wrapMode="none">
                    {endDetail()}
                  </text>
                </box>
              )
            }}
          </For>
        </scrollbox>
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

function runtimeSelectorOptionRowId(optionIndex: number): string {
  return `runtime-selector-option-${optionIndex}`
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

  const grouped = new Map<string, ModelSelectorGroup>()
  for (const model of models) {
    if (model.id === selectedModelId && normalizedQuery.length === 0) continue
    if (!matches(model)) continue

    const provider = providerSortKey(model)
    const title = providerDisplayName(model)
    const group = grouped.get(provider) ?? { provider, title, options: [] }
    group.options.push(toModelSelectorOption(model, model.id === selectedModelId))
    grouped.set(provider, group)
  }

  for (const group of [...grouped.values()].sort(compareModelSelectorGroups)) {
    sections.push({ title: group.title, options: group.options })
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
    detail: isFreeModel(model) ? freeModelBadge : providerDisplayName(model),
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

function providerSortKey(model: ModelSummary): string {
  const provider = model.provider.trim().toLowerCase()
  return provider.length > 0 ? provider : model.id.toLowerCase()
}

function compareModelSelectorGroups(a: ModelSelectorGroup, b: ModelSelectorGroup): number {
  const priorityDiff = providerSortPriority(a.provider) - providerSortPriority(b.provider)
  if (priorityDiff !== 0) return priorityDiff

  return a.title.localeCompare(b.title, undefined, { sensitivity: "base" })
}

function providerSortPriority(provider: string): number {
  const index = modelProviderOrder.indexOf(provider)
  return index === -1 ? modelProviderOrder.length : index
}

const providerDisplayNames: Record<string, string> = {
  claude: "Claude",
  "codex-oauth": "OpenAI OAuth",
  gemini: "Gemini",
  openai: "OpenAI",
  openrouter: "OpenRouter",
}

const modelProviderOrder = ["openai", "claude", "gemini", "codex-oauth", "openrouter"]

const freeModelBadge = "Free"

function isFreeModel(model: ModelSummary): boolean {
  return [model.id, model.name, model.modelName].some(
    (value) => typeof value === "string" && /(?:^|[:/\s_-])free(?:$|[:/\s_-])/i.test(value),
  )
}

function displayValue(value: string | null | undefined, fallback: string): string {
  const trimmed = value?.trim()
  return trimmed && trimmed.length > 0 ? trimmed : fallback
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

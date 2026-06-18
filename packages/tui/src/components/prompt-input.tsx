/** @jsxImportSource @opentui/solid */
import { createEffect, createSignal, For, onCleanup } from "solid-js"
import type { TextareaRenderable } from "@opentui/core"
import type { KeyEvent } from "@opentui/core"
import { listSlashCommandSuggestions, type SlashCommandSuggestion } from "../commands/slash-commands"
import type { AgentSummary, ModelActivity, ModelSummary, TuiState } from "../state/types"
import type { TuiTheme } from "../theme/themes"
import { formatContextUsage, promptHint, promptMeta } from "./session-shell-format"

export interface PromptInputProps {
  value: string
  agent: AgentSummary | null
  model: ModelSummary | null
  modelActivity: ModelActivity
  runStatus: TuiState["runStatus"]
  theme: TuiTheme
  focused?: boolean
  history?: string[]
  onChange(value: string): void
  onSubmit(value: string): void
  onFocusRequest?(): void
  onReasoningEffortChange?(delta: -1 | 1): boolean
}

export function PromptInput(props: PromptInputProps) {
  let textarea: (TextareaRenderable & { plainText?: string }) | undefined
  let programmaticValue: string | null = null
  const [barPhase, setBarPhase] = createSignal(0)
  const [selectedSuggestionIndex, setSelectedSuggestionIndex] = createSignal(0)
  const [draftValue, setDraftValue] = createSignal(props.value)
  const [historyIndex, setHistoryIndex] = createSignal<number | null>(null)
  const [historyDraft, setHistoryDraft] = createSignal("")
  const interval = setInterval(() => setBarPhase((phase) => (phase + 1) % 14), 120)
  const keyBindings = [
    { name: "return", action: "submit" as const },
    { name: "enter", action: "submit" as const },
    { name: "linefeed", action: "submit" as const },
    { name: "return", shift: true, action: "newline" as const },
    { name: "enter", shift: true, action: "newline" as const },
    { name: "linefeed", shift: true, action: "newline" as const },
  ]

  const currentValue = () => textarea?.plainText ?? draftValue()
  const commandSuggestions = () => listSlashCommandSuggestions(draftValue())
  const setTextareaValue = (value: string) => {
    if (textarea && textarea.plainText !== value) {
      programmaticValue = value
      textarea.setText(value)
      textarea.cursorOffset = value.length
    }
    setDraftValue(value)
  }
  const reportValue = (value: string) => {
    setTextareaValue(value)
    props.onChange(value)
  }
  createEffect(() => {
    setTextareaValue(props.value)
  })
  createEffect(() => {
    const count = commandSuggestions().length
    setSelectedSuggestionIndex((index) => (count === 0 ? 0 : Math.min(index, count - 1)))
  })
  const handleContentChange = (_event: unknown) => {
    const value = currentValue()
    setDraftValue(value)
    if (programmaticValue === value) {
      programmaticValue = null
      return
    }
    setHistoryIndex(null)
    setHistoryDraft("")
    props.onChange(value)
  }
  const handleSubmit = () => {
    const value = currentValue()
    setHistoryIndex(null)
    setHistoryDraft("")
    reportValue(value)
    textarea?.clear()
    setDraftValue("")
    props.onSubmit(value)
  }
  const handleSlashCompletion = () => {
    const suggestion = commandSuggestions()[selectedSuggestionIndex()]
    const completion = suggestion ? formatSuggestionCompletion(suggestion) : null
    if (!completion) return false

    if (!textarea) {
      reportValue(completion)
      return true
    }

    reportValue(completion)
    return true
  }
  const moveSlashSelection = (delta: -1 | 1) => {
    const count = commandSuggestions().length
    if (count === 0) return false

    setSelectedSuggestionIndex((index) => (index + delta + count) % count)
    return true
  }
  const moveHistory = (delta: -1 | 1) => {
    const history = props.history ?? []
    if (history.length === 0) return false

    const currentIndex = historyIndex()
    if (currentIndex === null) {
      if (delta > 0) return false
      setHistoryDraft(currentValue())
      const nextIndex = history.length - 1
      setHistoryIndex(nextIndex)
      reportValue(history[nextIndex] ?? "")
      return true
    }

    const nextIndex = currentIndex + delta
    if (nextIndex >= history.length) {
      setHistoryIndex(null)
      reportValue(historyDraft())
      setHistoryDraft("")
      return true
    }

    const clampedIndex = Math.max(0, nextIndex)
    setHistoryIndex(clampedIndex)
    reportValue(history[clampedIndex] ?? "")
    return true
  }
  const handleKeyDown = (event: KeyEvent) => {
    if (event.name === "up" && moveSlashSelection(-1)) {
      event.preventDefault()
      return
    }

    if (event.name === "down" && moveSlashSelection(1)) {
      event.preventDefault()
      return
    }

    if (event.name === "up" && moveHistory(-1)) {
      event.preventDefault()
      return
    }

    if (event.name === "down" && moveHistory(1)) {
      event.preventDefault()
      return
    }

    if (event.name === "tab" && !event.shift && handleSlashCompletion()) {
      event.preventDefault()
      return
    }

    if ((event.name === "left" || event.name === "right") && currentValue().length === 0) {
      const changed = props.onReasoningEffortChange?.(event.name === "right" ? 1 : -1) ?? false
      if (changed) {
        event.preventDefault()
        return
      }
    }

    if ((event.name === "return" || event.name === "enter" || event.name === "linefeed") && !event.shift) {
      event.preventDefault()
      handleSubmit()
    }
  }

  onCleanup(() => clearInterval(interval))

  return (
    <box flexDirection="column" flexShrink={0} backgroundColor={props.theme.surface} onMouseDown={props.onFocusRequest}>
      <box border={["left"]} borderColor={props.theme.task} backgroundColor={props.theme.panelAlt} paddingX={2} paddingY={1}>
        <textarea
          id="prompt-input-textarea"
          ref={(node) => {
            textarea = node as TextareaRenderable & { plainText?: string }
            setTextareaValue(props.value)
          }}
          focused={props.focused ?? true}
          minHeight={1}
          maxHeight={6}
          initialValue={props.value}
          keyBindings={keyBindings}
          backgroundColor={props.theme.panelAlt}
          textColor={props.theme.text}
          focusedBackgroundColor={props.theme.panelAlt}
          focusedTextColor={props.theme.text}
          cursorColor={props.theme.text}
          placeholder={'Ask anything... "example.com page title"'}
          placeholderColor={props.theme.textMuted}
          onContentChange={handleContentChange}
          onKeyDown={handleKeyDown}
          onSubmit={handleSubmit}
        />
      </box>
      <box
        visible={commandSuggestions().length > 0}
        flexDirection="column"
        border={["left"]}
        borderColor={props.theme.task}
        backgroundColor={props.theme.panelAlt}
        paddingX={2}
        paddingBottom={1}
      >
        <For each={commandSuggestions()}>
          {(command, index) => {
            const selected = () => index() === selectedSuggestionIndex()
            const selectSuggestion = () => {
              props.onFocusRequest?.()
              setSelectedSuggestionIndex(index())
            }
            return (
              <box
                id={`slash-suggestion-${index()}`}
                flexDirection="row"
                gap={2}
                backgroundColor={selected() ? props.theme.task : props.theme.panelAlt}
                paddingX={selected() ? 1 : 0}
                onMouseMove={selectSuggestion}
                onMouseOver={selectSuggestion}
                onMouseDown={() => {
                  selectSuggestion()
                  void handleSlashCompletion()
                }}
              >
                <text fg={selected() ? props.theme.surface : props.theme.text} wrapMode="none">
                  {command.name}
                </text>
                <text visible={Boolean(command.argumentHint)} fg={selected() ? props.theme.surface : props.theme.textMuted} wrapMode="none">
                  {command.argumentHint ?? ""}
                </text>
                <text fg={selected() ? props.theme.surface : props.theme.textMuted} wrapMode="none">
                  {command.description}
                </text>
              </box>
            )
          }}
        </For>
      </box>
      <box visible={props.modelActivity.status === "running"} paddingX={2} paddingTop={1}>
        <text fg={props.theme.reasoning} wrapMode="none">
          {inferenceLoadingBar(barPhase())}
        </text>
      </box>
      <box flexDirection="row" justifyContent="space-between" paddingX={2} paddingTop={1} paddingBottom={1} gap={2}>
        <text fg={props.theme.text} wrapMode="none">
          {promptMeta(props.agent, props.model)}
        </text>
        <text fg={props.theme.textMuted} wrapMode="none">
          {promptHint(props.runStatus, formatContextUsage(props.modelActivity))}
        </text>
      </box>
    </box>
  )
}

function formatSuggestionCompletion(suggestion: SlashCommandSuggestion): string {
  return suggestion.argumentHint ? `${suggestion.name} ` : suggestion.name
}

function inferenceLoadingBar(phase: number): string {
  const width = 18
  const filled = Math.min(width, phase + 5)
  const empty = Math.max(0, width - filled)
  return `[${"=".repeat(filled)}>${" ".repeat(empty)}] model inference`
}

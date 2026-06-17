import type { TextareaRenderable } from "@opentui/core"
import type { KeyEvent } from "@opentui/core"
import { createSignal, For, onCleanup, Show } from "solid-js"
import { listSlashCommandSuggestions } from "../commands/slash-commands"
import type { ModelActivity, ModelSummary, TuiState } from "../state/types"
import type { TuiTheme } from "../theme/themes"
import { formatContextUsage, promptHint, promptMeta } from "./session-shell-format"

export interface PromptInputProps {
  value: string
  model: ModelSummary | null
  modelActivity: ModelActivity
  runStatus: TuiState["runStatus"]
  theme: TuiTheme
  onChange(value: string): void
  onSubmit(): void
}

export function PromptInput(props: PromptInputProps) {
  let textarea: (TextareaRenderable & { plainText?: string }) | undefined
  const [barPhase, setBarPhase] = createSignal(0)
  const interval = setInterval(() => setBarPhase((phase) => (phase + 1) % 14), 120)
  const keyBindings = [
    { name: "return", action: "submit" as const },
    { name: "enter", action: "submit" as const },
    { name: "linefeed", action: "submit" as const },
    { name: "return", shift: true, action: "newline" as const },
    { name: "enter", shift: true, action: "newline" as const },
    { name: "linefeed", shift: true, action: "newline" as const },
  ]

  const currentValue = () => textarea?.plainText ?? props.value
  const commandSuggestions = () => listSlashCommandSuggestions(props.value)
  const handleContentChange = (_event: unknown) => {
    props.onChange(currentValue())
  }
  const handleSubmit = () => {
    props.onChange(currentValue())
    textarea?.clear()
    props.onSubmit()
  }
  const handleKeyDown = (event: KeyEvent) => {
    if ((event.name === "return" || event.name === "enter" || event.name === "linefeed") && !event.shift) {
      event.preventDefault()
      handleSubmit()
    }
  }

  onCleanup(() => clearInterval(interval))

  return (
    <box flexDirection="column" flexShrink={0} backgroundColor={props.theme.surface}>
      <box border={["left"]} borderColor={props.theme.task} backgroundColor={props.theme.panelAlt} paddingX={2} paddingY={1}>
        <textarea
          ref={(node) => {
            textarea = node as TextareaRenderable & { plainText?: string }
          }}
          focused
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
      <Show when={commandSuggestions().length > 0}>
        <box
          flexDirection="column"
          border={["left"]}
          borderColor={props.theme.task}
          backgroundColor={props.theme.panelAlt}
          paddingX={2}
          paddingBottom={1}
        >
          <For each={commandSuggestions()}>
            {(command, index) => {
              const selected = () => index() === 0
              return (
                <box
                  flexDirection="row"
                  gap={2}
                  backgroundColor={selected() ? props.theme.task : props.theme.panelAlt}
                  paddingX={selected() ? 1 : 0}
                >
                  <text fg={selected() ? props.theme.surface : props.theme.text} wrapMode="none">
                    {command.name}
                  </text>
                  <Show when={command.argumentHint}>
                    {(argumentHint) => (
                      <text fg={selected() ? props.theme.surface : props.theme.textMuted} wrapMode="none">
                        {argumentHint()}
                      </text>
                    )}
                  </Show>
                  <text fg={selected() ? props.theme.surface : props.theme.textMuted} wrapMode="none">
                    {command.description}
                  </text>
                </box>
              )
            }}
          </For>
        </box>
      </Show>
      {props.modelActivity.status === "running" ? (
        <box paddingX={2} paddingTop={1}>
          <text fg={props.theme.reasoning} wrapMode="none">
            {inferenceLoadingBar(barPhase())}
          </text>
        </box>
      ) : null}
      <box flexDirection="row" justifyContent="space-between" paddingX={2} paddingBottom={1} gap={2}>
        <text fg={props.theme.text} wrapMode="none">
          {promptMeta(props.model)}
        </text>
        <text fg={props.theme.textMuted} wrapMode="none">
          {promptHint(props.runStatus, formatContextUsage(props.modelActivity))}
        </text>
      </box>
    </box>
  )
}

function inferenceLoadingBar(phase: number): string {
  const width = 18
  const filled = Math.min(width, phase + 5)
  const empty = Math.max(0, width - filled)
  return `[${"=".repeat(filled)}>${" ".repeat(empty)}] model inference`
}

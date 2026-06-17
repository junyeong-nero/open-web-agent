import type { TextareaRenderable } from "@opentui/core"
import type { KeyEvent } from "@opentui/core"
import type { TuiState } from "../state/types"
import type { TuiTheme } from "../theme/themes"
import { promptHint, promptMeta } from "./session-shell-format"

export interface PromptInputProps {
  value: string
  agentId: string
  modelId: string | null
  environmentId: string
  runStatus: TuiState["runStatus"]
  theme: TuiTheme
  onChange(value: string): void
  onSubmit(): void
}

export function PromptInput(props: PromptInputProps) {
  let textarea: (TextareaRenderable & { plainText?: string }) | undefined
  const keyBindings = [
    { name: "return", action: "submit" as const },
    { name: "enter", action: "submit" as const },
    { name: "linefeed", action: "submit" as const },
    { name: "return", shift: true, action: "newline" as const },
    { name: "enter", shift: true, action: "newline" as const },
    { name: "linefeed", shift: true, action: "newline" as const },
  ]

  const currentValue = () => textarea?.plainText ?? props.value
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
      <box flexDirection="row" justifyContent="space-between" paddingX={2} paddingBottom={1} gap={2}>
        <text fg={props.theme.text} wrapMode="none">
          {promptMeta(props.agentId, props.modelId)}
        </text>
        <text fg={props.theme.textMuted} wrapMode="none">
          {promptHint(props.runStatus)}
        </text>
      </box>
    </box>
  )
}

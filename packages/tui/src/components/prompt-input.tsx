import type { TextareaRenderable } from "@opentui/core"
import type { KeyEvent } from "@opentui/core"

export interface PromptInputProps {
  value: string
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
    <box border title="Prompt" height={5}>
      <textarea
        ref={(node) => {
          textarea = node as TextareaRenderable & { plainText?: string }
        }}
        focused
        initialValue={props.value}
        keyBindings={keyBindings}
        onContentChange={handleContentChange}
        onKeyDown={handleKeyDown}
        onSubmit={handleSubmit}
      />
    </box>
  )
}

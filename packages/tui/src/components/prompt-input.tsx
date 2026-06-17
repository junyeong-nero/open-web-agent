import type { TextareaRenderable } from "@opentui/core"

export interface PromptInputProps {
  value: string
  onChange(value: string): void
  onSubmit(): void
}

export function PromptInput(props: PromptInputProps) {
  let textarea: (TextareaRenderable & { plainText?: string }) | undefined

  const currentValue = () => textarea?.plainText ?? props.value
  const handleContentChange = (_event: unknown) => {
    props.onChange(currentValue())
  }
  const handleSubmit = () => {
    props.onChange(currentValue())
    props.onSubmit()
    textarea?.clear()
  }

  return (
    <box border title="Prompt" height={5}>
      <textarea
        ref={(node) => {
          textarea = node as TextareaRenderable & { plainText?: string }
        }}
        focused
        initialValue={props.value}
        onContentChange={handleContentChange}
        onSubmit={handleSubmit}
      />
    </box>
  )
}

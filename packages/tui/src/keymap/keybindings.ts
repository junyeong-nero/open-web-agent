export type KeyAction = "quit" | "new" | "cancel-or-quit" | "focus-next" | "submit" | "newline"

export interface KeyLike {
  name?: string
  ctrl?: boolean
  shift?: boolean
  sequence?: string
}

export function mapKeyEvent(key: KeyLike): KeyAction | null {
  if (key.sequence === "\u0018q" || (key.ctrl && key.name === "q")) return "quit"
  if (key.sequence === "\u0018n" || (key.ctrl && key.name === "n")) return "new"
  if (key.ctrl && key.name === "c") return "cancel-or-quit"
  if (key.name === "tab") return "focus-next"
  if (key.name === "return" || key.name === "enter") return key.shift ? "newline" : "submit"
  return null
}

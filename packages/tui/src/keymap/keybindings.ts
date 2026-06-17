export type KeyAction = "quit" | "new" | "cancel-or-quit" | "copy-or-cancel" | "copy" | "paste" | "focus-next" | "submit" | "newline"

export interface KeyLike {
  name?: string
  ctrl?: boolean
  meta?: boolean
  super?: boolean
  shift?: boolean
  sequence?: string
}

export function mapKeyEvent(key: KeyLike): KeyAction | null {
  if (key.sequence === "\u0018q" || (key.ctrl && key.name === "q")) return "quit"
  if (key.sequence === "\u0018n" || (key.ctrl && key.name === "n")) return "new"
  if (key.sequence === "\u0003") return "copy-or-cancel"
  if (key.sequence === "\u0016") return "paste"
  if (key.name === "c" && key.ctrl) return "copy-or-cancel"
  if (key.name === "c" && (key.meta || key.super)) return "copy"
  if (key.name === "v" && (key.ctrl || key.meta || key.super)) return "paste"
  if (key.name === "tab") return "focus-next"
  if (key.name === "return" || key.name === "enter" || key.name === "linefeed") return key.shift ? "newline" : "submit"
  return null
}

export type KeyAction =
  | "quit"
  | "new"
  | "cancel-or-quit"
  | "focus-next"
  | "submit"
  | "newline"
  | "scroll-page-up"
  | "scroll-page-down"
  | "scroll-top"
  | "scroll-bottom"

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
  if (key.name === "pageup") return "scroll-page-up"
  if (key.name === "pagedown") return "scroll-page-down"
  if (key.name === "home") return "scroll-top"
  if (key.name === "end") return "scroll-bottom"
  if (key.name === "return" || key.name === "enter" || key.name === "linefeed") return key.shift ? "newline" : "submit"
  return null
}

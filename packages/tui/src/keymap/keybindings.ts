export type KeyAction =
  | "quit"
  | "new"
  | "cancel-or-quit"
  | "copy"
  | "paste"
  | "focus-next"
  | "focus-previous"
  | "scroll-line-up"
  | "scroll-line-down"
  | "scroll-page-up"
  | "scroll-page-down"
  | "scroll-top"
  | "scroll-bottom"
  | "reasoning-effort-decrease"
  | "reasoning-effort-increase"

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
  if (key.sequence === "\u0003" || (key.ctrl && key.name === "c")) return "quit"
  if (key.sequence === "\u0018n" || (key.ctrl && key.name === "n")) return "new"
  if (key.name === "c" && key.super) return "copy"
  if (key.name === "v" && key.super) return "paste"
  if (key.name === "tab" && key.shift) return "focus-previous"
  if (key.name === "tab") return "focus-next"
  if (key.name === "up") return "scroll-line-up"
  if (key.name === "down") return "scroll-line-down"
  if (key.name === "pageup") return "scroll-page-up"
  if (key.name === "pagedown") return "scroll-page-down"
  if (key.name === "home") return "scroll-top"
  if (key.name === "end") return "scroll-bottom"
  if (key.name === "left") return "reasoning-effort-decrease"
  if (key.name === "right") return "reasoning-effort-increase"
  return null
}

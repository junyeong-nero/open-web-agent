import { describe, expect, it } from "bun:test"
import { mapKeyEvent } from "./keybindings"

describe("mapKeyEvent", () => {
  it("maps ctrl+x q to quit", () => {
    expect(mapKeyEvent({ name: "q", ctrl: true, sequence: "\u0018q" })).toBe("quit")
  })

  it("leaves Enter submission to the focused prompt input", () => {
    expect(mapKeyEvent({ name: "return", sequence: "\r" })).toBeNull()
    expect(mapKeyEvent({ name: "enter", sequence: "\r" })).toBeNull()
    expect(mapKeyEvent({ name: "linefeed", sequence: "\n" })).toBeNull()
  })

  it("maps transcript scrolling keys", () => {
    expect(mapKeyEvent({ name: "pageup" })).toBe("scroll-page-up")
    expect(mapKeyEvent({ name: "pagedown" })).toBe("scroll-page-down")
    expect(mapKeyEvent({ name: "home" })).toBe("scroll-top")
    expect(mapKeyEvent({ name: "end" })).toBe("scroll-bottom")
  })

  it("maps ctrl+c to copy or cancel", () => {
    expect(mapKeyEvent({ name: "c", ctrl: true, sequence: "\u0003" })).toBe("copy-or-cancel")
    expect(mapKeyEvent({ ctrl: true, sequence: "\u0003" })).toBe("copy-or-cancel")
  })

  it("maps platform copy shortcuts to copy", () => {
    expect(mapKeyEvent({ name: "c", meta: true })).toBe("copy")
    expect(mapKeyEvent({ name: "c", super: true })).toBe("copy")
  })

  it("maps platform paste shortcuts to paste", () => {
    expect(mapKeyEvent({ name: "v", ctrl: true, sequence: "\u0016" })).toBe("paste")
    expect(mapKeyEvent({ ctrl: true, sequence: "\u0016" })).toBe("paste")
    expect(mapKeyEvent({ name: "v", meta: true })).toBe("paste")
    expect(mapKeyEvent({ name: "v", super: true })).toBe("paste")
  })
})

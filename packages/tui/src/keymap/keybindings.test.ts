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
    expect(mapKeyEvent({ name: "up" })).toBe("scroll-line-up")
    expect(mapKeyEvent({ name: "down" })).toBe("scroll-line-down")
    expect(mapKeyEvent({ name: "pageup" })).toBe("scroll-page-up")
    expect(mapKeyEvent({ name: "pagedown" })).toBe("scroll-page-down")
    expect(mapKeyEvent({ name: "home" })).toBe("scroll-top")
    expect(mapKeyEvent({ name: "end" })).toBe("scroll-bottom")
  })

  it("maps reasoning effort shortcut keys", () => {
    expect(mapKeyEvent({ name: "left" })).toBe("reasoning-effort-decrease")
    expect(mapKeyEvent({ name: "right" })).toBe("reasoning-effort-increase")
  })

  it("maps ctrl+c to quit", () => {
    expect(mapKeyEvent({ name: "c", ctrl: true, sequence: "\u0003" })).toBe("quit")
    expect(mapKeyEvent({ ctrl: true, sequence: "\u0003" })).toBe("quit")
  })

  it("does not map ctrl+v to paste", () => {
    expect(mapKeyEvent({ name: "v", ctrl: true, sequence: "\u0016" })).toBeNull()
    expect(mapKeyEvent({ ctrl: true, sequence: "\u0016" })).toBeNull()
  })

  it("maps super copy shortcuts to copy", () => {
    expect(mapKeyEvent({ name: "c", super: true })).toBe("copy")
  })

  it("maps super paste shortcuts to paste", () => {
    expect(mapKeyEvent({ name: "v", super: true })).toBe("paste")
  })

  it("does not treat meta as the macOS command shortcut", () => {
    expect(mapKeyEvent({ name: "c", meta: true })).toBeNull()
    expect(mapKeyEvent({ name: "v", meta: true })).toBeNull()
  })
})

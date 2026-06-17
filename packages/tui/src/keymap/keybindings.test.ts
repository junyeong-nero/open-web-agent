import { describe, expect, it } from "bun:test"
import { mapKeyEvent } from "./keybindings"

describe("mapKeyEvent", () => {
  it("maps ctrl+x q to quit", () => {
    expect(mapKeyEvent({ name: "q", ctrl: true, sequence: "\u0018q" })).toBe("quit")
  })

  it("maps linefeed to submit", () => {
    expect(mapKeyEvent({ name: "linefeed", sequence: "\n" })).toBe("submit")
  })

  it("maps transcript scrolling keys", () => {
    expect(mapKeyEvent({ name: "pageup" })).toBe("scroll-page-up")
    expect(mapKeyEvent({ name: "pagedown" })).toBe("scroll-page-down")
    expect(mapKeyEvent({ name: "home" })).toBe("scroll-top")
    expect(mapKeyEvent({ name: "end" })).toBe("scroll-bottom")
  })
})

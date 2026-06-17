import { describe, expect, it } from "bun:test"
import { getTheme, listThemes } from "./themes"

describe("themes", () => {
  it("lists the opencode theme first and falls back safely", () => {
    expect(listThemes().map((theme) => theme.id)).toEqual([
      "opencode",
      "terminal-cyan",
      "aurora-violet",
      "amber-ops",
      "matrix-green",
    ])
    expect(getTheme("opencode")).toMatchObject({
      id: "opencode",
      name: "OpenCode",
      surface: "#0a0a0a",
      panel: "#141414",
      panelAlt: "#1e1e1e",
      border: "#484848",
      text: "#eeeeee",
      textMuted: "#808080",
      accent: "#fab283",
      task: "#5c9cf5",
    })
    expect(getTheme("missing").id).toBe("opencode")
  })
})

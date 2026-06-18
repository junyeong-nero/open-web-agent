/** @jsxImportSource @opentui/solid */
import { describe, expect, it } from "bun:test"
import { ScrollBoxRenderable } from "@opentui/core"
import { testRender } from "@opentui/solid"
import type { SessionSummary } from "../state/types"
import { getTheme } from "../theme/themes"
import { SessionPalette, scrollSessionIndexIntoView, type SessionPaletteScrollTarget } from "./session-palette"

describe("SessionPalette", () => {
  it("renders as a centered overlay", async () => {
    const setup = await testRender(
      () => (
        <SessionPalette
          sessions={buildSessions(1)}
          activeSessionId="ses_0"
          selectedIndex={0}
          query=""
          mode="search"
          renameValue=""
          loadingPhase={0}
          theme={getTheme("opencode")}
        />
      ),
      { width: 96, height: 24 },
    )

    try {
      await setup.flush()
      const overlay = setup.renderer.root.findDescendantById("session-palette-overlay")
      const palette = setup.renderer.root.findDescendantById("session-palette")

      expect(overlay).toBeTruthy()
      expect(palette).toBeTruthy()
      expect(palette!.screenX).toBeGreaterThan(0)
      expect(palette!.screenY).toBeGreaterThan(0)
    } finally {
      setup.renderer.destroy()
    }
  })

  it("renders sessions in a scrollbox that responds to mouse wheel scrolling", async () => {
    const setup = await testRender(
      () => (
        <SessionPalette
          sessions={buildSessions(18)}
          activeSessionId="ses_0"
          selectedIndex={0}
          query=""
          mode="search"
          renameValue=""
          loadingPhase={0}
          theme={getTheme("opencode")}
        />
      ),
      { width: 72, height: 20 },
    )

    try {
      await setup.flush()
      const scrollbox = setup.renderer.root.findDescendantById("session-palette-list")

      expect(scrollbox).toBeInstanceOf(ScrollBoxRenderable)

      const sessionScroll = scrollbox as ScrollBoxRenderable
      expect(sessionScroll.scrollHeight).toBeGreaterThan(sessionScroll.viewport.height)

      await setup.mockMouse.scroll(sessionScroll.screenX + 1, sessionScroll.screenY + 1, "down")
      await setup.flush()

      expect(sessionScroll.scrollTop).toBeGreaterThan(0)
    } finally {
      setup.renderer.destroy()
    }
  })

  it("scrolls the selected session row into view", () => {
    const scroll = fakeScroll(0, 10)

    scrollSessionIndexIntoView(scroll, 16, 18)

    expect(scroll.scrollTop).toBe(7)
  })

  it("scrolls back up when the selected session is above the viewport", () => {
    const scroll = fakeScroll(8, 10)

    scrollSessionIndexIntoView(scroll, 2, 18)

    expect(scroll.scrollTop).toBe(2)
  })

  it("resets the session list scroll position for an empty result set", () => {
    const scroll = fakeScroll(4, 10)

    scrollSessionIndexIntoView(scroll, 0, 0)

    expect(scroll.scrollTop).toBe(0)
  })
})

function buildSessions(count: number): SessionSummary[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `ses_${index}`,
    projectPath: "/tmp/open-web-agent",
    projectHash: "project_hash",
    title: `Session ${index}`,
    pinned: false,
    deletedAt: null,
    createdAt: new Date(Date.UTC(2026, 0, index + 1)).toISOString(),
    runStatus: "idle",
    environmentId: null,
    browser: null,
  }))
}

function fakeScroll(scrollTop: number, viewportHeight: number): SessionPaletteScrollTarget {
  return {
    scrollTop,
    viewport: { height: viewportHeight },
    scrollTo(top: number) {
      this.scrollTop = top
    },
  }
}

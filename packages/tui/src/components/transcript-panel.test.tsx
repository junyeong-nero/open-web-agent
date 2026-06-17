/** @jsxImportSource @opentui/solid */
import { describe, expect, it } from "bun:test"
import { ScrollBoxRenderable } from "@opentui/core"
import { testRender } from "@opentui/solid"
import type { RunLogItem } from "../log/run-log"
import { createInitialState } from "../state/reducer"
import { getTheme } from "../theme/themes"
import { TranscriptPanel } from "./transcript-panel"

describe("TranscriptPanel", () => {
  it("renders the transcript in a sticky scrollbox", async () => {
    const state = {
      ...createInitialState("/tmp/project"),
      runLog: Array.from(
        { length: 20 },
        (_, index): RunLogItem => ({
          id: `task-${index}`,
          sequence: index,
          kind: "user.task",
          message: `Inspect a long page section ${index}`,
          accent: "task",
        }),
      ),
    }

    const setup = await testRender(() => <TranscriptPanel state={state} theme={getTheme("opencode")} />, {
      width: 40,
      height: 8,
    })

    try {
      await setup.flush()
      const scrollbox = setup.renderer.root.findDescendantById("transcript-scroll")

      expect(scrollbox).toBeInstanceOf(ScrollBoxRenderable)
      expect((scrollbox as ScrollBoxRenderable).stickyScroll).toBe(true)
      expect((scrollbox as ScrollBoxRenderable).stickyStart).toBe("bottom")

      const transcriptScroll = scrollbox as ScrollBoxRenderable
      expect(transcriptScroll.scrollHeight).toBeGreaterThan(transcriptScroll.viewport.height)
      transcriptScroll.scrollTo(0)
      transcriptScroll.scrollBy(1, "content")
      expect(transcriptScroll.scrollTop).toBeGreaterThan(0)
    } finally {
      setup.renderer.destroy()
    }
  })
})

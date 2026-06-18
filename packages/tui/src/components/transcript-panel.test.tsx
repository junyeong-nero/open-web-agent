/** @jsxImportSource @opentui/solid */
import { describe, expect, it } from "bun:test"
import { BoxRenderable, ScrollBoxRenderable } from "@opentui/core"
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

  it("can be focused by keyboard state and mouse cursor", async () => {
    let focusRequests = 0
    const state = createInitialState("/tmp/project")
    const setup = await testRender(
      () => <TranscriptPanel state={state} theme={getTheme("opencode")} focused onFocusRequest={() => focusRequests++} />,
      {
        width: 40,
        height: 8,
      },
    )

    try {
      await setup.flush()
      const scrollbox = setup.renderer.root.findDescendantById("transcript-scroll")

      expect(scrollbox).toBeInstanceOf(ScrollBoxRenderable)
      expect((scrollbox as ScrollBoxRenderable).focusable).toBe(true)
      expect((scrollbox as ScrollBoxRenderable).focused).toBe(true)

      await setup.mockMouse.click((scrollbox as ScrollBoxRenderable).screenX + 1, (scrollbox as ScrollBoxRenderable).screenY + 1)

      expect(focusRequests).toBe(1)
    } finally {
      setup.renderer.destroy()
    }
  })

  it("uses compact spacing between transcript items", async () => {
    const state = {
      ...createInitialState("/tmp/project"),
      runLog: [
        {
          id: "answer-1",
          sequence: 1,
          kind: "agent.answer",
          message: "First answer",
          accent: "answer",
        },
        {
          id: "answer-2",
          sequence: 2,
          kind: "agent.answer",
          message: "Second answer",
          accent: "answer",
        },
      ] satisfies RunLogItem[],
    }

    const setup = await testRender(() => <TranscriptPanel state={state} theme={getTheme("opencode")} />, {
      width: 56,
      height: 10,
    })

    try {
      await setup.flush()
      const scrollbox = setup.renderer.root.findDescendantById("transcript-scroll") as ScrollBoxRenderable
      const [first, second] = scrollbox.content.getChildrenSortedByPrimaryAxis()

      expect(second!.y - (first!.y + first!.height)).toBe(1)
    } finally {
      setup.renderer.destroy()
    }
  })

  it("renders final answers with the same framed treatment as user messages", async () => {
    const theme = getTheme("opencode")
    const state = {
      ...createInitialState("/tmp/project"),
      runLog: [
        {
          id: "answer",
          sequence: 1,
          kind: "agent.answer",
          message: "네이버에서 오늘 날씨를 확인할 수 있습니다.",
          accent: "answer",
        },
      ] satisfies RunLogItem[],
    }

    const setup = await testRender(() => <TranscriptPanel state={state} theme={theme} />, {
      width: 56,
      height: 8,
    })

    try {
      await setup.flush()
      const answer = setup.renderer.root.findDescendantById("transcript-assistant-answer")

      expect(answer).toBeInstanceOf(BoxRenderable)
      expect((answer as BoxRenderable).border).toEqual(["left"])
      expect((answer as BoxRenderable).backgroundColor.toInts()).toEqual([30, 30, 30, 255])
    } finally {
      setup.renderer.destroy()
    }
  })

  it("expands tool call boxes to show arguments when clicked", async () => {
    const state = {
      ...createInitialState("/tmp/project"),
      runLog: [
        {
          id: "tool-call",
          sequence: 1,
          kind: "tool.call",
          message: "type today weather",
          accent: "tool",
          toolCall: {
            action: "type",
            argsJson: '{\n  "target": {\n    "selector": "#query"\n  },\n  "value": "today weather"\n}',
          },
        },
      ] as RunLogItem[],
    }

    const setup = await testRender(() => <TranscriptPanel state={state} theme={getTheme("opencode")} />, {
      width: 72,
      height: 12,
    })

    try {
      await setup.flush()
      const toolBox = setup.renderer.root.findDescendantById("transcript-tool-tool-call")
      expect(toolBox).toBeInstanceOf(BoxRenderable)
      expect(setup.renderer.root.findDescendantById("transcript-tool-args-tool-call")?.visible).toBe(false)
      await setup.mockMouse.click((toolBox as BoxRenderable).screenX + 5, (toolBox as BoxRenderable).screenY)
      await setup.flush()

      const args = setup.renderer.root.findDescendantById("transcript-tool-args-tool-call")
      expect(args?.visible).toBe(true)
    } finally {
      setup.renderer.destroy()
    }
  })
})

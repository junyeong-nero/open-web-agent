import { describe, expect, it } from "bun:test"
import type { RunEvent } from "@open-web-agent/core"
import { createInitialState, reduceTuiEvent } from "./reducer"

function event(type: RunEvent["type"], payload: Record<string, unknown> = {}): RunEvent {
  return {
    id: `evt_${type}`,
    runId: "run_1",
    sessionId: "ses_1",
    stepId: null,
    sequence: 1,
    type,
    payload,
    createdAt: "2026-06-17T00:00:00.000Z",
  }
}

describe("reduceTuiEvent", () => {
  it("uses opencode shell defaults", () => {
    expect(createInitialState("/tmp/project")).toMatchObject({
      selectedAgentId: "mock-agent",
      selectedModelId: null,
      selectedEnvironmentId: "mock-browser",
      selectedThemeId: "opencode",
    })
  })

  it("adds timeline item for browser action events", () => {
    const state = reduceTuiEvent(
      createInitialState("/tmp/project"),
      {
        type: "run.event",
        event: event("browser.action.started", {
          action: { id: "action_1", kind: "inspect_page_title" },
        }),
      },
    )

    expect(state.timeline).toEqual([
      {
        eventId: "evt_browser.action.started",
        sequence: 1,
        type: "browser.action.started",
        label: "inspect_page_title",
      },
    ])
  })

  it("appends final answer on run.completed", () => {
    const state = reduceTuiEvent(
      createInitialState("/tmp/project"),
      {
        type: "run.event",
        event: event("run.completed", { finalAnswer: '페이지 제목은 "Example Domain"입니다.' }),
      },
    )

    expect(state.runStatus).toBe("completed")
    expect(state.conversation).toContainEqual({
      role: "assistant",
      content: '페이지 제목은 "Example Domain"입니다.',
    })
  })

  it("stores plan items on plan.created", () => {
    const state = reduceTuiEvent(createInitialState("/tmp/project"), {
      type: "run.event",
      event: event("plan.created", { items: [{ id: "plan_1", title: "Open page", status: "pending" }] }),
    })

    expect(state.plan).toEqual([{ id: "plan_1", title: "Open page", status: "pending" }])
  })

  it("replaces plan items on plan.updated", () => {
    const withPlan = reduceTuiEvent(createInitialState("/tmp/project"), {
      type: "run.event",
      event: event("plan.created", { items: [{ id: "plan_1", title: "Open page", status: "pending" }] }),
    })

    const state = reduceTuiEvent(withPlan, {
      type: "run.event",
      event: event("plan.updated", { items: [{ id: "plan_2", title: "Retry click", status: "active" }] }),
    })

    expect(state.plan).toEqual([{ id: "plan_2", title: "Retry click", status: "active" }])
  })

  it("clears local view state while preserving session and run controls", () => {
    const initial = createInitialState("/tmp/project")
    const withSession = reduceTuiEvent(initial, { type: "session.created", sessionId: "ses_1" })
    const running = reduceTuiEvent(withSession, { type: "run.event", event: event("run.started") })
    const withConversation = reduceTuiEvent(running, {
      type: "conversation.append",
      message: { role: "user", content: "find the title" },
    })
    const withTimeline = reduceTuiEvent(withConversation, {
      type: "run.event",
      event: event("observation.captured", {
        observation: {
          url: "https://example.com",
          title: "Example Domain",
          text: "Example Domain",
          screenshotPath: "/tmp/example.png",
          interactiveElements: [],
          metadata: {},
        },
      }),
    })

    const state = reduceTuiEvent(withTimeline, { type: "state.clear" })

    expect(state.projectPath).toBe("/tmp/project")
    expect(state.activeSessionId).toBe("ses_1")
    expect(state.activeRunId).toBe("run_1")
    expect(state.runStatus).toBe("running")
    expect(state.inspectorVisible).toBe(true)
    expect(state.selectedEvent).toBeNull()
    expect(state.conversation).toEqual([])
    expect(state.timeline).toEqual([])
    expect(state.plan).toEqual([])
    expect(state.browser.url).toBe("about:blank")
  })
})

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
})

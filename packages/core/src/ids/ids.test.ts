import { describe, expect, it } from "bun:test"
import {
  makeActionId,
  makeEventId,
  makeId,
  makeRunId,
  makeSessionId,
  makeStepId,
  makeToolCallId,
} from "./ids"

describe("ID helpers", () => {
  it("creates IDs with the expected prefixes", () => {
    expect(makeSessionId()).toStartWith("ses_")
    expect(makeRunId()).toStartWith("run_")
    expect(makeEventId()).toStartWith("evt_")
    expect(makeStepId()).toStartWith("step_")
    expect(makeActionId()).toStartWith("action_")
    expect(makeToolCallId()).toStartWith("tool_")
    expect(makeId("run")).toMatch(/^run_[0-9a-f]+$/)
  })
})

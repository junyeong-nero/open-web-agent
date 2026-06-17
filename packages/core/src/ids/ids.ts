import { randomUUID } from "node:crypto"

export type IdPrefix = "ses" | "run" | "evt" | "step" | "action" | "tool"

export function makeId(prefix: IdPrefix): string {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`
}

export const makeSessionId = () => makeId("ses")
export const makeRunId = () => makeId("run")
export const makeEventId = () => makeId("evt")
export const makeStepId = () => makeId("step")
export const makeActionId = () => makeId("action")
export const makeToolCallId = () => makeId("tool")

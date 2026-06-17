import { z } from "zod"

export const RunEventTypeSchema = z.enum([
  "server.connected",
  "session.created",
  "run.started",
  "run.cancelled",
  "run.failed",
  "run.completed",
  "observation.captured",
  "agent.step.started",
  "agent.step.completed",
  "browser.action.started",
  "browser.action.completed",
  "browser.tool.started",
  "browser.tool.completed",
  "model.called",
  "model.completed",
  "human.approval.requested",
])

export const RunEventSchema = z.object({
  id: z.string(),
  runId: z.string(),
  sessionId: z.string(),
  stepId: z.string().nullable(),
  sequence: z.number().int().nonnegative(),
  type: RunEventTypeSchema,
  payload: z.record(z.string(), z.unknown()),
  createdAt: z.string(),
})

export type RunEvent = z.infer<typeof RunEventSchema>
export type RunEventType = z.infer<typeof RunEventTypeSchema>

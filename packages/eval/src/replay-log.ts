import { z } from "zod"
import { BrowserToolCallSchema, type RunEvent } from "@open-web-agent/core"

export const ReplayCombinationSchema = z.object({
  agentId: z.string(),
  modelId: z.string(),
  environmentId: z.string(),
})

const ReplayObservationSchema = z.object({
  url: z.string(),
  title: z.string().nullable(),
  text: z.string().nullable(),
})

const ReplayToolResultSchema = z.object({
  ok: z.boolean(),
  message: z.string().nullable(),
  observation: ReplayObservationSchema.nullable(),
  metadata: z.record(z.string(), z.unknown()).default({}),
})

const ReplayBrowserToolEntrySchema = z.object({
  sequence: z.number().int().nonnegative(),
  type: z.literal("browser.tool"),
  toolCall: BrowserToolCallSchema,
  result: ReplayToolResultSchema,
  latencyMs: z.number().nonnegative(),
})

const ReplayModelEntrySchema = z.object({
  sequence: z.number().int().nonnegative(),
  type: z.literal("model"),
  latencyMs: z.number().nonnegative(),
  inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
  totalTokens: z.number().int().nonnegative().optional(),
  costUsd: z.number().nonnegative(),
})

const ReplayCompletedEntrySchema = z.object({
  sequence: z.number().int().nonnegative(),
  type: z.literal("run.completed"),
  finalAnswer: z.string(),
})

const ReplayFailedEntrySchema = z.object({
  sequence: z.number().int().nonnegative(),
  type: z.literal("run.failed"),
  message: z.string(),
})

export const ReplayActionLogEntrySchema = z.discriminatedUnion("type", [
  ReplayBrowserToolEntrySchema,
  ReplayModelEntrySchema,
  ReplayCompletedEntrySchema,
  ReplayFailedEntrySchema,
])

export const ReplayActionLogSchema = z.object({
  version: z.literal(1),
  taskId: z.string(),
  combo: ReplayCombinationSchema,
  entries: z.array(ReplayActionLogEntrySchema),
})

export type ReplayCombination = z.infer<typeof ReplayCombinationSchema>
export type ReplayToolResult = z.infer<typeof ReplayToolResultSchema>
export type ReplayActionLogEntry = z.infer<typeof ReplayActionLogEntrySchema>
export type ReplayActionLog = z.infer<typeof ReplayActionLogSchema>

export interface CreateReplayActionLogInput {
  taskId: string
  combo: ReplayCombination
  events: RunEvent[]
}

export function createReplayActionLog(input: CreateReplayActionLogInput): ReplayActionLog {
  return ReplayActionLogSchema.parse({
    version: 1,
    taskId: input.taskId,
    combo: input.combo,
    entries: input.events.flatMap(toReplayEntry),
  })
}

function toReplayEntry(event: RunEvent): ReplayActionLogEntry[] {
  if (event.type === "browser.tool.completed") {
    const toolCall = BrowserToolCallSchema.safeParse(event.payload.toolCall)
    if (!toolCall.success) return []

    return [
      {
        sequence: event.sequence,
        type: "browser.tool",
        toolCall: toolCall.data,
        result: readToolResult(event.payload.result),
        latencyMs: readLatencyMs(event.payload.result),
      },
    ]
  }

  if (event.type === "model.completed") {
    return [readModelEntry(event)]
  }

  if (event.type === "run.completed") {
    return [{ sequence: event.sequence, type: "run.completed", finalAnswer: String(event.payload.finalAnswer ?? "") }]
  }

  if (event.type === "run.failed") {
    return [{ sequence: event.sequence, type: "run.failed", message: String(event.payload.message ?? "") }]
  }

  return []
}

function readToolResult(value: unknown): ReplayToolResult {
  if (!isRecord(value)) {
    return { ok: false, message: "Missing browser result", observation: null, metadata: {} }
  }

  return {
    ok: value.ok === true,
    message: typeof value.message === "string" ? value.message : null,
    observation: readObservation(value.observation),
    metadata: isRecord(value.metadata) ? value.metadata : {},
  }
}

function readObservation(value: unknown): z.infer<typeof ReplayObservationSchema> | null {
  if (!isRecord(value)) return null
  return {
    url: typeof value.url === "string" ? value.url : "",
    title: typeof value.title === "string" ? value.title : null,
    text: typeof value.text === "string" ? value.text : null,
  }
}

function readModelEntry(event: RunEvent): ReplayActionLogEntry {
  const response = isRecord(event.payload.response) ? event.payload.response : event.payload
  const usage = isRecord(response.usage) ? response.usage : {}
  const entry: ReplayActionLogEntry = {
    sequence: event.sequence,
    type: "model",
    latencyMs: numberValue(response.latencyMs),
    costUsd: numberValue(response.costUsd ?? event.payload.costUsd),
  }

  if (typeof usage.inputTokens === "number") entry.inputTokens = usage.inputTokens
  if (typeof usage.outputTokens === "number") entry.outputTokens = usage.outputTokens
  if (typeof usage.totalTokens === "number") entry.totalTokens = usage.totalTokens

  return entry
}

function readLatencyMs(value: unknown): number {
  if (!isRecord(value) || !isRecord(value.metadata)) return 0
  return numberValue(value.metadata.latencyMs)
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

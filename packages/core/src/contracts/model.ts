import { z } from "zod"

export const ModelContentPartSchema = z.object({ type: z.string() }).passthrough()

export const ModelMessageSchema = z.object({
  role: z.enum(["system", "user", "assistant", "tool"]),
  content: z.union([z.string(), z.array(ModelContentPartSchema).min(1)]),
})

export const ModelRequestSchema = z.object({
  model: z.string(),
  messages: z.array(ModelMessageSchema).min(1),
  temperature: z.number().min(0).max(2).default(0),
  topP: z.number().min(0).max(1).optional(),
  maxTokens: z.number().int().positive().optional(),
  presencePenalty: z.number().min(-2).max(2).optional(),
  frequencyPenalty: z.number().min(-2).max(2).optional(),
  seed: z.number().int().optional(),
  stop: z.union([z.string(), z.array(z.string()).min(1)]).optional(),
  extraBody: z.record(z.string(), z.unknown()).optional(),
  responseFormat: z.enum(["text", "json"]).default("text"),
})

export const ModelUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative().nullable(),
  outputTokens: z.number().int().nonnegative().nullable(),
  totalTokens: z.number().int().nonnegative().nullable(),
})

export const ModelResponseSchema = z.object({
  id: z.string().nullable(),
  text: z.string(),
  raw: z.unknown(),
  usage: ModelUsageSchema.nullable(),
  latencyMs: z.number().nonnegative(),
})

export type ModelMessage = z.infer<typeof ModelMessageSchema>
export type ModelContentPart = z.infer<typeof ModelContentPartSchema>
export type ModelRequest = z.infer<typeof ModelRequestSchema>
export type ModelUsage = z.infer<typeof ModelUsageSchema>
export type ModelResponse = z.infer<typeof ModelResponseSchema>

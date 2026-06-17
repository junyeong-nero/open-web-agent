import { z } from "zod"

export const ModelMessageSchema = z.object({
  role: z.enum(["system", "user", "assistant", "tool"]),
  content: z.string(),
})

export const ModelRequestSchema = z.object({
  model: z.string(),
  messages: z.array(ModelMessageSchema).min(1),
  temperature: z.number().min(0).max(2).default(0),
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
export type ModelRequest = z.infer<typeof ModelRequestSchema>
export type ModelUsage = z.infer<typeof ModelUsageSchema>
export type ModelResponse = z.infer<typeof ModelResponseSchema>

import { z } from "zod"

export const ModelContentPartSchema = z.object({ type: z.string() }).passthrough()

export const ModelToolDefinitionSchema = z.object({
  name: z.string().min(1).max(64).regex(/^[a-zA-Z0-9_-]+$/),
  description: z.string().min(1),
  inputSchema: z.record(z.string(), z.unknown()),
  strict: z.boolean().optional(),
})

export const ModelToolCallSchema = z.object({
  id: z.string(),
  name: z.string().min(1),
  arguments: z.unknown(),
})

export const ModelToolResultSchema = z.object({
  toolCallId: z.string().min(1),
  name: z.string().min(1),
  output: z.unknown(),
  isError: z.boolean(),
})

export const ModelMessageSchema = z
  .object({
    role: z.enum(["system", "user", "assistant", "tool"]),
    content: z.union([z.string(), z.array(ModelContentPartSchema).min(1)]),
    toolCalls: z.array(ModelToolCallSchema).min(1).optional(),
    toolCallId: z.string().min(1).optional(),
    name: z.string().min(1).optional(),
  })
  .superRefine((message, ctx) => {
    if (message.toolCalls && message.role !== "assistant") {
      ctx.addIssue({ code: "custom", path: ["toolCalls"], message: "toolCalls require assistant role" })
    }
    if (message.role === "tool") {
      if (!message.toolCallId) {
        ctx.addIssue({ code: "custom", path: ["toolCallId"], message: "tool messages require toolCallId" })
      }
      if (!message.name) {
        ctx.addIssue({ code: "custom", path: ["name"], message: "tool messages require name" })
      }
    } else if (message.toolCallId || message.name) {
      ctx.addIssue({ code: "custom", message: "toolCallId and name require tool role" })
    }
  })

export const ModelRequestSchema = z.object({
  model: z.string(),
  messages: z.array(ModelMessageSchema).min(1),
  tools: z.array(ModelToolDefinitionSchema).min(1).optional(),
  toolChoice: z.enum(["auto", "none"]).optional(),
  temperature: z.number().min(0).max(2).optional(),
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
  toolCalls: z.array(ModelToolCallSchema).default([]),
  raw: z.unknown(),
  usage: ModelUsageSchema.nullable(),
  latencyMs: z.number().nonnegative(),
})

export type ModelMessage = z.infer<typeof ModelMessageSchema>
export type ModelContentPart = z.infer<typeof ModelContentPartSchema>
export type ModelToolDefinition = z.infer<typeof ModelToolDefinitionSchema>
export type ModelToolCall = z.infer<typeof ModelToolCallSchema>
export type ModelToolResult = z.infer<typeof ModelToolResultSchema>
export type ModelRequest = z.infer<typeof ModelRequestSchema>
export type ModelUsage = z.infer<typeof ModelUsageSchema>
export type ModelResponse = z.infer<typeof ModelResponseSchema>

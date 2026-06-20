import { z } from "zod"

export const BoundingBoxSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
})

export const ElementRefSchema = z.object({
  id: z.string(),
  role: z.string().nullable(),
  name: z.string().nullable(),
  text: z.string().nullable(),
  selector: z.string().nullable(),
  xpath: z.string().nullable(),
  boundingBox: BoundingBoxSchema.nullable(),
  attributes: z.record(z.string(), z.string()).default({}),
})

export const ActionTargetSchema = z.object({
  elementId: z.string().nullable().default(null),
  selector: z.string().nullable().default(null),
  text: z.string().nullable().default(null),
  role: z.string().nullable().default(null),
  name: z.string().nullable().default(null),
  coordinates: z
    .object({
      x: z.number(),
      y: z.number(),
    })
    .nullable()
    .default(null),
})

export const BrowserToolTypeSchema = z.enum([
  "navigate",
  "click",
  "type",
  "scroll",
  "wait",
  "press_key",
  "screenshot",
  "extract_text",
  "go_back",
  "go_forward",
])

export const BrowserToolParameterSchema = z.object({
  name: z.string(),
  type: z.string(),
  required: z.boolean(),
  description: z.string(),
})

export const BrowserToolDefinitionSchema = z.object({
  type: BrowserToolTypeSchema,
  description: z.string(),
  parameters: z.array(BrowserToolParameterSchema),
  example: z.record(z.string(), z.unknown()),
})

export const BrowserToolCallSchema = z.discriminatedUnion("type", [
  z.object({ id: z.string(), type: z.literal("navigate"), url: z.string().url() }),
  z.object({ id: z.string(), type: z.literal("click"), target: ActionTargetSchema }),
  z.object({ id: z.string(), type: z.literal("type"), target: ActionTargetSchema, value: z.string() }),
  z.object({ id: z.string(), type: z.literal("scroll"), deltaX: z.number().default(0), deltaY: z.number() }),
  z.object({ id: z.string(), type: z.literal("wait"), ms: z.number().int().positive() }),
  z.object({ id: z.string(), type: z.literal("press_key"), key: z.string() }),
  z.object({ id: z.string(), type: z.literal("screenshot") }),
  z.object({ id: z.string(), type: z.literal("extract_text") }),
  z.object({ id: z.string(), type: z.literal("go_back") }),
  z.object({ id: z.string(), type: z.literal("go_forward") }),
])

export const BrowserActionSchema = z.object({
  id: z.string(),
  kind: z.string(),
  reason: z.string().nullable(),
  requiresApproval: z.boolean().default(false),
  toolCalls: z.array(BrowserToolCallSchema).min(1),
})

export const ObservationSchema = z.object({
  url: z.string(),
  title: z.string().nullable(),
  text: z.string().nullable(),
  screenshotPath: z.string().nullable(),
  interactiveElements: z.array(ElementRefSchema),
  metadata: z.record(z.string(), z.unknown()).default({}),
})

export const ActionResultSchema = z.object({
  ok: z.boolean(),
  message: z.string().nullable(),
  observation: ObservationSchema.nullable(),
  metadata: z.record(z.string(), z.unknown()).default({}),
})

export type BrowserToolCall = z.infer<typeof BrowserToolCallSchema>
export type BrowserToolType = z.infer<typeof BrowserToolTypeSchema>
export type BrowserToolParameter = z.infer<typeof BrowserToolParameterSchema>
export type BrowserToolDefinition = z.infer<typeof BrowserToolDefinitionSchema>
export type BrowserAction = z.infer<typeof BrowserActionSchema>
export type Observation = z.infer<typeof ObservationSchema>
export type ActionResult = z.infer<typeof ActionResultSchema>

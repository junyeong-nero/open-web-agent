import { z } from "zod"

export const CreateSessionRequestSchema = z.object({
  projectPath: z.string().min(1),
  environmentId: z.string().min(1).optional(),
  title: z.string().trim().min(1).nullable().optional(),
})

export const UpdateSessionRequestSchema = z
  .object({
    title: z.string().trim().min(1).nullable().optional(),
    pinned: z.boolean().optional(),
  })
  .refine((value) => value.title !== undefined || value.pinned !== undefined, {
    message: "At least one session field is required",
  })

export const CreateRunRequestSchema = z.object({
  sessionId: z.string().min(1),
  prompt: z.string().min(1),
  agentId: z.string().min(1).optional(),
  modelId: z.string().min(1).optional(),
  environmentId: z.string().min(1).optional(),
})

export const UpdateModelConfigRequestSchema = z.object({
  modelId: z.string().min(1),
  reasoningEffort: z.enum(["low", "medium", "high"]).optional(),
})

export const UpdateAgentConfigRequestSchema = z.object({
  agentId: z.string().min(1),
})

export const UpdateBrowserConfigRequestSchema = z.object({
  browserId: z.string().min(1),
})

export const UpdateBrowserHeadlessConfigRequestSchema = z.object({
  browserHeadless: z.boolean(),
})

export type CreateSessionRequest = z.infer<typeof CreateSessionRequestSchema>
export type UpdateSessionRequest = z.infer<typeof UpdateSessionRequestSchema>
export type CreateRunRequest = z.infer<typeof CreateRunRequestSchema>
export type UpdateModelConfigRequest = z.infer<typeof UpdateModelConfigRequestSchema>
export type UpdateAgentConfigRequest = z.infer<typeof UpdateAgentConfigRequestSchema>
export type UpdateBrowserConfigRequest = z.infer<typeof UpdateBrowserConfigRequestSchema>
export type UpdateBrowserHeadlessConfigRequest = z.infer<typeof UpdateBrowserHeadlessConfigRequestSchema>

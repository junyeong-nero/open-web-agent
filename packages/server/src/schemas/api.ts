import { z } from "zod"

export const CreateSessionRequestSchema = z.object({
  projectPath: z.string().min(1),
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

export type CreateSessionRequest = z.infer<typeof CreateSessionRequestSchema>
export type UpdateSessionRequest = z.infer<typeof UpdateSessionRequestSchema>
export type CreateRunRequest = z.infer<typeof CreateRunRequestSchema>

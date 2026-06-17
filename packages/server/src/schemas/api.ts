import { z } from "zod"

export const CreateSessionRequestSchema = z.object({
  projectPath: z.string().min(1),
})

export const CreateRunRequestSchema = z.object({
  sessionId: z.string().min(1),
  prompt: z.string().min(1),
})

export type CreateSessionRequest = z.infer<typeof CreateSessionRequestSchema>
export type CreateRunRequest = z.infer<typeof CreateRunRequestSchema>

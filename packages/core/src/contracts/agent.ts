import { z } from "zod"
import { BrowserActionSchema } from "./browser"

export const AgentDecisionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("browser_actions"),
    thought: z.string().nullable(),
    actions: z.array(BrowserActionSchema).min(1),
  }),
  z.object({
    type: z.literal("final_answer"),
    thought: z.string().nullable(),
    finalAnswer: z.string(),
    confidence: z.number().min(0).max(1).nullable(),
  }),
])

export type AgentDecision = z.infer<typeof AgentDecisionSchema>

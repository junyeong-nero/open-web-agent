import type { ModelRequest } from "@open-web-agent/core"

export function withChatReasoningEffort(request: ModelRequest, reasoningEffort?: string | null): ModelRequest {
  if (!reasoningEffort) return request
  return {
    ...request,
    extraBody: {
      ...(request.extraBody ?? {}),
      reasoning_effort: reasoningEffort,
    },
  }
}

export function withResponsesReasoningEffort(request: ModelRequest, reasoningEffort?: string | null): ModelRequest {
  if (!reasoningEffort) return request
  return {
    ...request,
    extraBody: {
      ...(request.extraBody ?? {}),
      reasoning: { effort: reasoningEffort },
    },
  }
}

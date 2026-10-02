import type { Message, ModelAdapter, ModelRequest, ModelResponse } from "../model/types"

/** A fake model that replies from a script; each step sees the requests it was sent so far. */
export function scriptedModel(
  script: Array<(request: ModelRequest) => ModelResponse | Promise<ModelResponse>>,
): ModelAdapter & { requests: ModelRequest[] } {
  const requests: ModelRequest[] = []
  return {
    name: "scripted",
    requests,
    async complete(request) {
      requests.push(structuredClone({ ...request, signal: undefined }))
      const next = script[requests.length - 1]
      if (!next) throw new Error(`scripted model has no reply for call ${requests.length}`)
      return next(request)
    },
  }
}

export function lastToolText(messages: Message[]): string {
  const last = messages.findLast((message) => message.role === "tool")
  if (last?.role !== "tool") return ""
  return last.content.map((part) => (part.type === "text" ? part.text : "")).join("\n")
}

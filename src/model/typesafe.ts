import { type FetchLike, type ModelAdapter, type ModelRequest, type ModelResponse, postJson, reportedUsage } from "./types"

export interface TypeSafeSystemOneOptions {
  model: string
  baseUrl?: string
  apiKey?: string
  /** Merged into every request body. */
  extraBody?: Record<string, unknown>
  fetch?: FetchLike
}

/**
 * TypeSafe System One (`POST /v1/systemone`), e.g. `typesafe:jev-latest`. Jev answers typed questions about a text and
 * writes no text of its own, so it can only judge: the system prompt becomes one yes/no (Noul) question about the text of
 * the messages, and the response text is Jev's probability of yes, e.g. `0.82`. Requests that offer tools fail.
 */
export function typesafeSystemOne(options: TypeSafeSystemOneOptions): ModelAdapter {
  const baseUrl = (options.baseUrl ?? "https://api.typesafe.ai/v1").replace(/\/+$/, "")
  const fetchImpl = options.fetch ?? fetch
  const name = `typesafe-systemone:${options.model}`

  return {
    name,
    async complete(request: ModelRequest): Promise<ModelResponse> {
      if (request.tools.length > 0) throw new Error(`${name} only answers yes/no questions; use it as the judge model, not as the agent model`)
      const state = request.messages
        .flatMap((message) => (message.role === "assistant" ? [message.text ?? ""] : message.content.map((part) => (part.type === "text" ? part.text : ""))))
        .filter(Boolean)
        .join("\n\n")
      const headers: Record<string, string> = {}
      if (options.apiKey) headers.authorization = `Bearer ${options.apiKey}`

      const json = (await postJson(fetchImpl, name, `${baseUrl}/systemone`, headers, {
        model: options.model,
        state,
        questions: { answer: { type: "noul", instructions: request.system } },
        ...options.extraBody,
      }, request.signal)) as { model?: string; answers?: { answer?: { noul?: unknown } }; usage?: { input_tokens?: unknown; output_tokens?: unknown } }
      const yes = json.answers?.answer?.noul
      if (typeof yes !== "number") throw new Error(`${name} returned no yes/no answer`)

      return {
        text: String(yes),
        toolCalls: [],
        model: json.model || undefined,
        // TypeSafe bills input tokens only; output tokens are reported but free.
        usage: reportedUsage({ inputTokens: json.usage?.input_tokens, outputTokens: json.usage?.output_tokens }),
      }
    },
  }
}

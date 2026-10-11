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
 * writes no text of its own, so it can only judge and check. The system prompt becomes one yes/no (Noul) question about
 * the text of the messages, and the response text is Jev's probability of yes, e.g. `0.82`. With `choices`, it becomes
 * one Choice question over them instead, and a text that is a JSON object goes as that object. The response text is then
 * `{"label":"<choice>","confidence":<its probability>}`. Requests that offer tools fail.
 */
export function typesafeSystemOne(options: TypeSafeSystemOneOptions): ModelAdapter {
  const baseUrl = (options.baseUrl ?? "https://api.typesafe.ai/v1").replace(/\/+$/, "")
  const fetchImpl = options.fetch ?? fetch
  const name = `typesafe-systemone:${options.model}`

  return {
    name,
    answersChoices: true,
    async complete(request: ModelRequest): Promise<ModelResponse> {
      if (request.tools.length > 0) throw new Error(`${name} only answers yes/no and choice questions; use it as the judge or checker model, not as the agent model`)
      const state = request.messages
        .flatMap((message) => (message.role === "assistant" ? [message.text ?? ""] : message.content.map((part) => (part.type === "text" ? part.text : ""))))
        .filter(Boolean)
        .join("\n\n")
      const headers: Record<string, string> = {}
      if (options.apiKey) headers.authorization = `Bearer ${options.apiKey}`
      const { choices } = request

      const json = (await postJson(fetchImpl, name, `${baseUrl}/systemone`, headers, {
        model: options.model,
        state: choices ? jsonObject(state) ?? state : state,
        questions: { answer: choices ? { type: "choice", instructions: request.system, criteria: choices } : { type: "noul", instructions: request.system } },
        ...options.extraBody,
      }, request.signal)) as {
        model?: string
        answers?: { answer?: { noul?: unknown; choice?: unknown; probabilities?: Record<string, unknown> } }
        usage?: { input_tokens?: unknown; output_tokens?: unknown }
      }
      const answer = json.answers?.answer
      let text: string
      if (choices) {
        const label = answer?.choice
        const probability = typeof label === "string" ? answer?.probabilities?.[label] : undefined
        if (typeof label !== "string" || typeof probability !== "number") throw new Error(`${name} returned no choice`)
        text = JSON.stringify({ label, confidence: probability })
      } else {
        if (typeof answer?.noul !== "number") throw new Error(`${name} returned no yes/no answer`)
        text = String(answer.noul)
      }

      return {
        text,
        toolCalls: [],
        model: json.model || undefined,
        // TypeSafe bills input tokens only; output tokens are reported but free.
        usage: reportedUsage({ inputTokens: json.usage?.input_tokens, outputTokens: json.usage?.output_tokens }),
      }
    },
  }
}

/** `text` parsed when it is a JSON object, so that its fields reach the model as named parts of the state. */
function jsonObject(text: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(text)
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined
  } catch {
    return undefined
  }
}

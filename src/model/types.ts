export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image"; mimeType: string; data: string }

export interface ToolCall {
  id: string
  name: string
  arguments: Record<string, unknown>
}

export type Message =
  | { role: "user"; content: ContentPart[] }
  | { role: "assistant"; text?: string; toolCalls: ToolCall[] }
  | { role: "tool"; toolCallId: string; name: string; content: ContentPart[]; isError?: boolean }

export interface ToolSpec {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

export interface ModelRequest {
  system: string
  messages: Message[]
  tools: ToolSpec[]
  signal?: AbortSignal
}

/** Token counts and cost as the provider reported them. A field the provider did not send is left out, never zero. */
export interface Usage {
  /** Every input token, including cache reads and writes. */
  inputTokens?: number
  outputTokens?: number
  /** Input tokens read from the provider's prompt cache. */
  cachedInputTokens?: number
  /** Input tokens written to the provider's prompt cache. */
  cacheWriteTokens?: number
  /** What the provider charged, in its own unit (OpenRouter: US dollars). */
  cost?: number
}

export interface ModelResponse {
  text?: string
  toolCalls: ToolCall[]
  /** Provider-reported termination reason, retained for response diagnostics. */
  finishReason?: string
  /** The model that served the request, as the response named it; a router names the model it chose. */
  model?: string
  usage?: Usage
}

/** The whole model boundary: one provider-neutral request in, one response out. */
export interface ModelAdapter {
  readonly name: string
  complete(request: ModelRequest): Promise<ModelResponse>
}

export class ModelHttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    adapter: string,
  ) {
    super(`${adapter} request failed with HTTP ${status}: ${body.slice(0, 500)}`)
    this.name = "ModelHttpError"
  }
}

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>

export async function postJson(
  fetchImpl: FetchLike,
  adapter: string,
  url: string,
  headers: Record<string, string>,
  body: unknown,
  signal?: AbortSignal,
): Promise<unknown> {
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
    signal,
  })
  const text = await response.text()
  if (!response.ok) {
    let safeText = text
    for (const [key, value] of Object.entries(headers)) {
      if (/^(authorization|x-api-key)$/i.test(key) && value) {
        const secret = value.replace(/^Bearer\s+/i, "")
        if (secret) safeText = safeText.replaceAll(secret, "[redacted]")
      }
    }
    throw new ModelHttpError(response.status, safeText, adapter)
  }
  return JSON.parse(text)
}

/** Keep the usage fields that hold a number; undefined when none does. Missing or null values are not turned into zeros. */
export function reportedUsage(fields: { [K in keyof Usage]: unknown }): Usage | undefined {
  const reported = Object.entries(fields).filter(([, value]) => typeof value === "number" && Number.isFinite(value))
  return reported.length > 0 ? Object.fromEntries(reported) : undefined
}

export function parseToolArguments(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as Record<string, unknown>
  if (typeof raw !== "string" || raw.trim() === "") return {}
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : { _raw: raw }
  } catch {
    return { _raw: raw }
  }
}

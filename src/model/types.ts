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

export interface ModelResponse {
  text?: string
  toolCalls: ToolCall[]
  usage?: { inputTokens?: number; outputTokens?: number }
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
  if (!response.ok) throw new ModelHttpError(response.status, text, adapter)
  return JSON.parse(text)
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

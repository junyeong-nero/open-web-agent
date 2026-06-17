import {
  AgentDecisionSchema,
  type AgentDecision,
  type AgentPlugin,
  type AgentState,
  type ModelPlugin,
  type ModelRequest,
  type Observation,
  type RuntimeContext,
} from "@open-web-agent/core"

export interface SimpleReActAgentOptions {
  model: ModelPlugin
  modelName: string
  timeoutMs?: number
  maxParseRetries?: number
}

export class SimpleReActAgent implements AgentPlugin {
  id = "simple-react-agent"
  name = "Simple ReAct Agent"
  description = "Uses a model to choose browser actions or return a final answer."
  private readonly timeoutMs: number
  private readonly maxParseRetries: number

  constructor(private readonly options: SimpleReActAgentOptions) {
    this.timeoutMs = options.timeoutMs ?? 30_000
    this.maxParseRetries = options.maxParseRetries ?? 1
  }

  async initialize(_ctx: RuntimeContext): Promise<void> {}

  async step(state: AgentState, ctx: RuntimeContext): Promise<AgentDecision> {
    let lastError: string | null = null
    let lastRaw = ""

    for (let attempt = 0; attempt <= this.maxParseRetries; attempt += 1) {
      const request = this.buildRequest(state, lastError, lastRaw)
      const response = await withTimeout(this.options.model.complete(request, ctx), this.timeoutMs, ctx.abortSignal)
      lastRaw = response.text

      try {
        return parseDecision(response.text)
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error)
      }
    }

    throw new Error(`Invalid model decision after retry. Raw output: ${lastRaw}`)
  }

  async finalize(state: AgentState, _ctx: RuntimeContext): Promise<string> {
    return state.finalAnswer ?? ""
  }

  private buildRequest(state: AgentState, lastError: string | null, lastRaw: string): ModelRequest {
    return {
      model: this.options.modelName,
      temperature: 0,
      responseFormat: "json",
      messages: [
        {
          role: "system",
          content: [
            "You are Open Web Agent's browser-control agent.",
            "Return only JSON matching one of these shapes:",
            '{"type":"browser_actions","thought":string|null,"actions":[{"id":string,"kind":string,"reason":string|null,"requiresApproval":boolean,"toolCalls":[...]}]}',
            '{"type":"final_answer","thought":string|null,"finalAnswer":string,"confidence":number|null}',
            "Browser tool calls must be nested under browser_actions.actions[].toolCalls.",
          ].join("\n"),
        },
        {
          role: "user",
          content: [
            `Task: ${state.prompt}`,
            "",
            "Current observation:",
            formatObservationForPrompt(state.lastObservation),
            "",
            `Completed steps: ${state.steps.length}`,
            ...(lastError
              ? [
                  "",
                  `Previous response was invalid: ${lastError}`,
                  "Raw response:",
                  lastRaw,
                  "Return corrected JSON only.",
                ]
              : []),
          ].join("\n"),
        },
      ],
    }
  }
}

export function formatObservationForPrompt(observation: Observation | null): string {
  if (!observation) return "No browser observation has been captured yet."

  const elements = observation.interactiveElements
    .slice(0, 20)
    .map((element, index) =>
      [
        `${index + 1}. id=${element.id}`,
        `role=${element.role ?? ""}`,
        `name=${element.name ?? ""}`,
        `text=${element.text ?? ""}`,
        `selector=${element.selector ?? ""}`,
      ].join(" "),
    )
    .join("\n")

  return [
    `URL: ${observation.url}`,
    `Title: ${observation.title ?? ""}`,
    "Text:",
    observation.text ?? "",
    "Interactive elements:",
    elements || "None",
  ].join("\n")
}

function parseDecision(text: string): AgentDecision {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new Error(`Model returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }

  return AgentDecisionSchema.parse(parsed)
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new DOMException("Run cancelled", "AbortError"))

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Model call timed out after ${timeoutMs}ms`)), timeoutMs)
    const onAbort = () => reject(new DOMException("Run cancelled", "AbortError"))

    signal.addEventListener("abort", onAbort, { once: true })
    promise.then(
      (value) => {
        clearTimeout(timeout)
        signal.removeEventListener("abort", onAbort)
        resolve(value)
      },
      (error) => {
        clearTimeout(timeout)
        signal.removeEventListener("abort", onAbort)
        reject(error)
      },
    )
  })
}

import {
  AgentDecisionSchema,
  type AgentDecision,
  type AgentPlugin,
  type AgentState,
  type BrowserAction,
  type BrowserToolCall,
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

type ObservedElement = Observation["interactiveElements"][number]

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
        return repairDecisionTargets(parseDecision(response.text), state.lastObservation)
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error)
      }
    }

    const errorDetail = lastError ? ` Last error: ${lastError}` : ""
    throw new Error(`Invalid model decision after retry.${errorDetail} Raw output: ${lastRaw}`)
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
            'Type example: {"id":"tool_1","type":"type","target":{"selector":"input[name=\\"query\\"]"},"value":"tomorrow weather"}',
            'Click example: {"id":"tool_2","type":"click","target":{"selector":"button[type=\\"submit\\"]"}}',
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

  return AgentDecisionSchema.parse(normalizeModelDecision(parsed))
}

function repairDecisionTargets(decision: AgentDecision, observation: Observation | null): AgentDecision {
  if (decision.type !== "browser_actions" || !observation) return decision

  return {
    ...decision,
    actions: decision.actions.map((action) => ({
      ...action,
      toolCalls: action.toolCalls.map((toolCall) => repairToolCallTarget(toolCall, action, observation)),
    })),
  }
}

function repairToolCallTarget(
  toolCall: BrowserToolCall,
  action: BrowserAction,
  observation: Observation,
): BrowserToolCall {
  if (toolCall.type !== "click" && toolCall.type !== "type") return toolCall
  if (hasUsableTarget(toolCall.target)) return toolCall

  const element = chooseTargetElement(toolCall.type, action, observation)
  if (!element) return toolCall

  return {
    ...toolCall,
    target: targetFromElement(element),
  } as BrowserToolCall
}

function hasUsableTarget(target: Extract<BrowserToolCall, { type: "click" | "type" }>["target"]): boolean {
  return Boolean(target.selector || target.text || target.role || target.name || target.coordinates || target.elementId)
}

function chooseTargetElement(
  toolType: Extract<BrowserToolCall, { type: "click" | "type" }>["type"],
  action: BrowserAction,
  observation: Observation,
): ObservedElement | null {
  if (toolType === "type") return findInputElement(observation)

  const actionText = `${action.kind} ${action.reason ?? ""}`.toLowerCase()
  if (actionText.includes("검색창") || actionText.includes("search box") || actionText.includes("input")) {
    return findInputElement(observation)
  }

  if (actionText.includes("검색") || actionText.includes("search") || actionText.includes("submit")) {
    return (
      observation.interactiveElements.find((element) => isButtonElement(element) && elementMatchesSearch(element)) ??
      findButtonElement(observation)
    )
  }

  return findButtonElement(observation)
}

function findInputElement(observation: Observation): ObservedElement | null {
  return observation.interactiveElements.find(isInputElement) ?? null
}

function findButtonElement(observation: Observation): ObservedElement | null {
  return observation.interactiveElements.find(isButtonElement) ?? null
}

function isInputElement(element: ObservedElement): boolean {
  const role = element.role?.toLowerCase() ?? ""
  const type = element.attributes.type?.toLowerCase() ?? ""
  return (
    ["combobox", "input", "searchbox", "textbox", "textarea"].includes(role) ||
    ["search", "text", "email", "url", "tel", "number"].includes(type)
  )
}

function isButtonElement(element: ObservedElement): boolean {
  const role = element.role?.toLowerCase() ?? ""
  const type = element.attributes.type?.toLowerCase() ?? ""
  return role === "button" || type === "button" || type === "submit"
}

function elementMatchesSearch(element: ObservedElement): boolean {
  const text = [element.id, element.name, element.text, element.attributes["aria-label"], element.attributes.title]
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .toLowerCase()
  return text.includes("검색") || text.includes("search")
}

function targetFromElement(element: ObservedElement): Extract<BrowserToolCall, { type: "click" | "type" }>["target"] {
  return {
    elementId: element.id,
    selector: element.selector,
    text: element.text,
    role: element.role,
    name: element.name,
    coordinates: null,
  }
}

function normalizeModelDecision(value: unknown): unknown {
  if (!isRecord(value) || value.type !== "browser_actions" || !Array.isArray(value.actions)) return value

  return {
    ...value,
    actions: value.actions.map((action, actionIndex) => {
      if (!isRecord(action) || !Array.isArray(action.toolCalls)) return action

      const actionId = typeof action.id === "string" && action.id.length > 0 ? action.id : `action_${actionIndex + 1}`
      return {
        ...action,
        toolCalls: action.toolCalls.map((toolCall, toolIndex) => normalizeToolCall(toolCall, actionId, toolIndex)),
      }
    }),
  }
}

function normalizeToolCall(toolCall: unknown, actionId: string, toolIndex: number): unknown {
  if (!isRecord(toolCall)) return toolCall

  const args = isRecord(toolCall.arguments) ? toolCall.arguments : isRecord(toolCall.args) ? toolCall.args : {}
  const normalized: Record<string, unknown> = { ...args, ...toolCall }
  delete normalized.arguments
  delete normalized.args

  if (typeof normalized.type !== "string" && typeof normalized.name === "string") {
    normalized.type = normalized.name
  }
  delete normalized.name
  if (typeof normalized.type !== "string" && typeof normalized.kind === "string") {
    normalized.type = normalized.kind
  }
  delete normalized.kind

  if (normalized.type === "navigate" && typeof normalized.url !== "string" && isRecord(normalized.target)) {
    const targetUrl = normalized.target.url
    if (typeof targetUrl === "string") {
      normalized.url = targetUrl
    }
  }

  if (!isRecord(normalized.target) && typeof normalized.ref === "string" && normalized.ref.length > 0) {
    normalized.target = { selector: selectorForRef(normalized.ref) }
  }
  delete normalized.ref

  if (isTargetedToolCallType(normalized.type) && typeof normalized.selector === "string" && normalized.selector.length > 0) {
    const target = isRecord(normalized.target) ? normalized.target : {}
    if (typeof target.selector !== "string" || target.selector.length === 0) {
      normalized.target = { ...target, selector: normalized.selector }
    }
  }
  delete normalized.selector

  if (normalized.type === "type" && typeof normalized.value !== "string" && typeof normalized.text === "string") {
    normalized.value = normalized.text
  }
  if (normalized.type !== "final_answer") {
    delete normalized.text
  }

  if (typeof normalized.id !== "string" || normalized.id.length === 0) {
    normalized.id = `${actionId}_tool_${toolIndex + 1}`
  }

  return normalized
}

function isTargetedToolCallType(value: unknown): value is "click" | "type" {
  return value === "click" || value === "type"
}

function selectorForRef(ref: string): string {
  if (ref.startsWith("#") || ref.startsWith(".") || ref.startsWith("[")) return ref
  return `#${ref}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
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

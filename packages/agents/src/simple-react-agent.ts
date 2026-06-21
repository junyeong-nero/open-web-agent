import {
  AgentDecisionSchema,
  redactSensitiveData,
  type AgentDecision,
  type AgentPlugin,
  type AgentState,
  type BrowserAction,
  type BrowserToolCall,
  type BrowserToolDefinition,
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
      const request = this.buildRequest(state, ctx, lastError, lastRaw)
      const response = await withTimeout(
        (abortSignal) => this.options.model.complete(request, { ...ctx, abortSignal }),
        this.timeoutMs,
        ctx.abortSignal,
      )
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

  private buildRequest(state: AgentState, ctx: RuntimeContext, lastError: string | null, lastRaw: string): ModelRequest {
    const failedResults = formatFailedBrowserResults(state)

    return {
      model: this.options.modelName,
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
            formatBrowserToolsForPrompt(ctx.browserTools),
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
            ...(failedResults
              ? [
                  "",
                  "Failed browser results:",
                  failedResults,
                  "Choose a different target or recovery action instead of repeating the same failed tool call.",
                ]
              : []),
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

function formatBrowserToolsForPrompt(tools: BrowserToolDefinition[]): string {
  if (tools.length === 0) return "Available browser tools:\nNone."

  return ["Available browser tools:", ...tools.map(formatBrowserToolForPrompt)].join("\n")
}

function formatBrowserToolForPrompt(tool: BrowserToolDefinition): string {
  const parameters =
    tool.parameters.length > 0
      ? tool.parameters
          .map(
            (parameter) =>
              `${parameter.name} (${parameter.type}, ${parameter.required ? "required" : "optional"}) - ${parameter.description}`,
          )
          .join("; ")
      : "none"

  return [`- ${tool.type}: ${tool.description}`, `  Parameters: ${parameters}`, `  Example: ${JSON.stringify(tool.example)}`].join(
    "\n",
  )
}

function formatFailedBrowserResults(state: AgentState): string {
  return state.steps
    .flatMap((step, stepIndex) =>
      step.actionResults
        .filter((result) => !result.ok)
        .map((result) => `Step ${stepIndex + 1}: ${result.message ?? "Browser tool failed"}`),
    )
    .slice(-5)
    .join("\n")
}

export function formatObservationForPrompt(observation: Observation | null): string {
  if (!observation) return "No browser observation has been captured yet."
  const safeObservation = redactSensitiveData(observation)

  const elements = safeObservation.interactiveElements
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
    `URL: ${safeObservation.url}`,
    `Title: ${safeObservation.title ?? ""}`,
    "Text:",
    safeObservation.text ?? "",
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

function withTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) return Promise.reject(abortErrorFromSignal(signal))

  const operationAbort = new AbortController()

  return new Promise((resolve, reject) => {
    let settled = false
    const cleanup = () => {
      clearTimeout(timeout)
      signal.removeEventListener("abort", onAbort)
    }
    const settleResolve = (value: T) => {
      if (settled) return
      settled = true
      cleanup()
      resolve(value)
    }
    const settleReject = (error: unknown) => {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    }
    const timeout = setTimeout(() => {
      const error = new Error(`Model call timed out after ${timeoutMs}ms`)
      operationAbort.abort(error)
      settleReject(error)
    }, timeoutMs)
    const onAbort = () => {
      const error = abortErrorFromSignal(signal)
      operationAbort.abort(error)
      settleReject(error)
    }

    signal.addEventListener("abort", onAbort, { once: true })
    try {
      operation(operationAbort.signal).then(settleResolve, settleReject)
    } catch (error) {
      settleReject(error)
    }
  })
}

function abortErrorFromSignal(signal: AbortSignal): unknown {
  if (signal.reason instanceof Error && signal.reason.name !== "AbortError") return signal.reason
  return new DOMException("Run cancelled", "AbortError")
}

import {
  BrowserToolCallSchema,
  type BrowserCapability,
  type BrowserToolCall,
  type BrowserToolDefinition,
} from "../contracts/browser"
import type { ModelToolCall } from "../contracts/model"
import { redactSensitiveData } from "../redaction/sensitive-data"

export type BrowserToolValidationCode =
  | "unknown_tool"
  | "capability_disabled"
  | "invalid_tool_call_id"
  | "invalid_tool_arguments"
  | "unsupported_capability"
  | "not_executed_due_to_invalid_batch"

export interface BrowserToolValidationIssue {
  path: Array<string | number>
  code: string
  message: string
}

export class BrowserToolValidationError extends Error {
  constructor(
    readonly code: BrowserToolValidationCode,
    message: string,
    readonly issues: BrowserToolValidationIssue[] = [],
  ) {
    super(message)
    this.name = "BrowserToolValidationError"
  }

  toModelOutput(): { code: BrowserToolValidationCode; message: string; issues: BrowserToolValidationIssue[] } {
    return { code: this.code, message: this.message, issues: this.issues }
  }
}

export function assertSupportedBrowserCapabilities(
  requested: BrowserCapability[],
  supported: BrowserCapability[],
): void {
  const supportedSet = new Set(supported)
  for (const capability of requested) {
    if (!supportedSet.has(capability)) {
      throw new BrowserToolValidationError(
        "unsupported_capability",
        `Unsupported browser capability: ${capability}`,
      )
    }
  }
}

export function parseModelToolCallFromDefinitions(
  call: ModelToolCall,
  definitions: BrowserToolDefinition[],
): BrowserToolCall {
  if (!call.id) {
    throw new BrowserToolValidationError("invalid_tool_call_id", "Browser tool call ID must not be empty")
  }
  const definition = definitions.find((candidate) => candidate.name === call.name)
  if (!definition) throw new BrowserToolValidationError("unknown_tool", `Unknown browser tool: ${call.name}`)
  if (!isRecord(call.arguments)) {
    throw new BrowserToolValidationError("invalid_tool_arguments", `Invalid arguments for ${call.name}`)
  }
  const parsed = BrowserToolCallSchema.safeParse({
    id: call.id,
    type: definition.type,
    ...call.arguments,
  })
  if (!parsed.success) {
    throw new BrowserToolValidationError(
      "invalid_tool_arguments",
      `Invalid arguments for ${call.name}`,
      parsed.error.issues.map((issue) => ({
        path: issue.path.map((part) => (typeof part === "symbol" ? String(part) : part)),
        code: issue.code,
        message: issue.message,
      })),
    )
  }
  return parsed.data
}

export function browserToolCallToModelToolCall(
  call: BrowserToolCall,
  definitions: BrowserToolDefinition[],
  options: { redact: boolean },
): ModelToolCall {
  const definition = definitions.find((candidate) => candidate.type === call.type)
  if (!definition) throw new BrowserToolValidationError("unknown_tool", `Unknown browser tool type: ${call.type}`)
  const argumentsValue = Object.fromEntries(Object.entries(call).filter(([key]) => key !== "id" && key !== "type"))
  const modelArguments = options.redact
    ? (
        redactSensitiveData({
          name: definition.name,
          arguments: argumentsValue,
        }) as { arguments: unknown }
      ).arguments
    : argumentsValue
  return {
    id: call.id,
    name: definition.name,
    arguments: modelArguments,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

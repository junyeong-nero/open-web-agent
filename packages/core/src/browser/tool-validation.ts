import type { BrowserCapability } from "../contracts/browser"

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

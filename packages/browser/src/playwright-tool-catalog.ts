import { z, type ZodType } from "zod"
import {
  BrowserToolValidationError,
  browserToolCallToModelToolCall,
  ClickArgumentsSchema,
  EmptyBrowserToolArgumentsSchema,
  NavigateArgumentsSchema,
  PressKeyArgumentsSchema,
  parseModelToolCallFromDefinitions,
  ScrollArgumentsSchema,
  TypeArgumentsSchema,
  WaitArgumentsSchema,
  type BrowserCapability,
  type BrowserToolCall,
  type BrowserToolDefinition,
  type ModelToolCall,
} from "@open-web-agent/core"

interface PlaywrightToolDescriptor {
  definition: BrowserToolDefinition
  argumentsSchema: ZodType
}

function descriptor(
  definition: Omit<BrowserToolDefinition, "inputSchema">,
  argumentsSchema: ZodType,
): PlaywrightToolDescriptor {
  return {
    definition: {
      ...definition,
      inputSchema: z.toJSONSchema(argumentsSchema) as Record<string, unknown>,
    },
    argumentsSchema,
  }
}

const DESCRIPTORS: PlaywrightToolDescriptor[] = [
  descriptor(
    {
      name: "browser_navigate",
      type: "navigate",
      capability: "core",
      description: "Open an absolute HTTP(S) URL in the current browser page.",
      readOnly: false,
      requiresApproval: false,
      parameters: [{ name: "url", type: "string", required: true, description: "Absolute HTTP(S) URL to open." }],
      example: { id: "tool_1", type: "navigate", url: "https://example.com" },
    },
    NavigateArgumentsSchema,
  ),
  descriptor(
    {
      name: "browser_click",
      type: "click",
      capability: "core",
      description: "Click an interactive element or viewport coordinate.",
      readOnly: false,
      requiresApproval: false,
      parameters: [
        { name: "target", type: "ActionTarget", required: true, description: "Element or coordinates to click." },
      ],
      example: { id: "tool_2", type: "click", target: { selector: 'button[type="submit"]' } },
    },
    ClickArgumentsSchema,
  ),
  descriptor(
    {
      name: "browser_type",
      type: "type",
      capability: "core",
      description: "Fill text into an editable element.",
      readOnly: false,
      requiresApproval: false,
      parameters: [
        { name: "target", type: "ActionTarget", required: true, description: "Editable element to fill." },
        { name: "value", type: "string", required: true, description: "Text to enter." },
      ],
      example: {
        id: "tool_3",
        type: "type",
        target: { selector: 'input[name="query"]' },
        value: "tomorrow weather",
      },
    },
    TypeArgumentsSchema,
  ),
  descriptor(
    {
      name: "browser_scroll",
      type: "scroll",
      capability: "core",
      description: "Scroll the current page by pixel deltas.",
      readOnly: false,
      requiresApproval: false,
      parameters: [
        { name: "deltaX", type: "number", required: false, description: "Horizontal pixels." },
        { name: "deltaY", type: "number", required: true, description: "Vertical pixels." },
      ],
      example: { id: "tool_4", type: "scroll", deltaX: 0, deltaY: 700 },
    },
    ScrollArgumentsSchema,
  ),
  descriptor(
    {
      name: "browser_wait_for",
      type: "wait",
      capability: "core",
      description: "Wait for a fixed number of milliseconds.",
      readOnly: false,
      requiresApproval: false,
      parameters: [{ name: "ms", type: "positive integer", required: true, description: "Milliseconds to wait." }],
      example: { id: "tool_5", type: "wait", ms: 1000 },
    },
    WaitArgumentsSchema,
  ),
  descriptor(
    {
      name: "browser_press_key",
      type: "press_key",
      capability: "core",
      description: "Press a Playwright keyboard key.",
      readOnly: false,
      requiresApproval: false,
      parameters: [{ name: "key", type: "string", required: true, description: "Playwright key name." }],
      example: { id: "tool_6", type: "press_key", key: "Enter" },
    },
    PressKeyArgumentsSchema,
  ),
  descriptor(
    {
      name: "browser_take_screenshot",
      type: "screenshot",
      capability: "core",
      description: "Capture a full-page screenshot artifact.",
      readOnly: true,
      requiresApproval: false,
      parameters: [],
      example: { id: "tool_7", type: "screenshot" },
    },
    EmptyBrowserToolArgumentsSchema,
  ),
  descriptor(
    {
      name: "browser_extract_text",
      type: "extract_text",
      capability: "core",
      description: "Return visible text from the current browser observation.",
      readOnly: true,
      requiresApproval: false,
      parameters: [],
      example: { id: "tool_8", type: "extract_text" },
    },
    EmptyBrowserToolArgumentsSchema,
  ),
  descriptor(
    {
      name: "browser_navigate_back",
      type: "go_back",
      capability: "core",
      description: "Navigate back in browser history.",
      readOnly: false,
      requiresApproval: false,
      parameters: [],
      example: { id: "tool_9", type: "go_back" },
    },
    EmptyBrowserToolArgumentsSchema,
  ),
  descriptor(
    {
      name: "browser_navigate_forward",
      type: "go_forward",
      capability: "core",
      description: "Navigate forward in browser history.",
      readOnly: false,
      requiresApproval: false,
      parameters: [],
      example: { id: "tool_10", type: "go_forward" },
    },
    EmptyBrowserToolArgumentsSchema,
  ),
]

export const PLAYWRIGHT_SUPPORTED_CAPABILITIES: BrowserCapability[] = ["core"]

export function listPlaywrightBrowserTools(capabilities: BrowserCapability[]): BrowserToolDefinition[] {
  const enabled = new Set(capabilities)
  return DESCRIPTORS.filter((entry) => enabled.has(entry.definition.capability)).map((entry) => entry.definition)
}

export function parsePlaywrightModelToolCall(
  call: ModelToolCall,
  capabilities: BrowserCapability[],
): BrowserToolCall {
  if (!call.id) {
    throw new BrowserToolValidationError("invalid_tool_call_id", "Browser tool call ID must not be empty")
  }
  const descriptor = DESCRIPTORS.find((entry) => entry.definition.name === call.name)
  if (!descriptor) throw new BrowserToolValidationError("unknown_tool", `Unknown browser tool: ${call.name}`)
  if (!capabilities.includes(descriptor.definition.capability)) {
    throw new BrowserToolValidationError(
      "capability_disabled",
      `Capability ${descriptor.definition.capability} is disabled for ${call.name}`,
    )
  }

  return parseModelToolCallFromDefinitions(call, listPlaywrightBrowserTools(capabilities))
}

export function validatePlaywrightBrowserToolCall(
  call: BrowserToolCall,
  capabilities: BrowserCapability[],
): BrowserToolCall {
  const descriptor = DESCRIPTORS.find((entry) => entry.definition.type === call.type)
  if (!descriptor) throw new BrowserToolValidationError("unknown_tool", `Unknown browser tool type: ${call.type}`)
  return parsePlaywrightModelToolCall(browserToolCallToModelToolCall(call, [descriptor.definition], { redact: false }), capabilities)
}

export function playwrightModelToolName(call: BrowserToolCall): string {
  const descriptor = DESCRIPTORS.find((entry) => entry.definition.type === call.type)
  if (!descriptor) throw new BrowserToolValidationError("unknown_tool", `Unknown browser tool type: ${call.type}`)
  return descriptor.definition.name
}

export function playwrightToolRequiresApproval(call: BrowserToolCall): boolean {
  const descriptor = DESCRIPTORS.find((entry) => entry.definition.type === call.type)
  if (!descriptor) throw new BrowserToolValidationError("unknown_tool", `Unknown browser tool type: ${call.type}`)
  return descriptor.definition.requiresApproval
}

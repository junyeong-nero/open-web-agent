# Native Browser Tool Calling and Capabilities

## Goal

Open Web Agent will expose its browser tools to model providers through native function/tool calling while preserving the existing runtime boundary:

```text
AgentDecision(browser_actions)
  -> BrowserAction[]
  -> BrowserToolCall[]
  -> ToolAdapter.execute()
```

The first release adds:

- a capability-aware browser tool catalog;
- native tool calling for the existing OpenAI-compatible and OpenAI Responses transports;
- the existing ten browser operations under the always-enabled `core` capability;
- execution-time validation that cannot be bypassed by the legacy JSON decision path;
- compatibility with existing agents, browser events, JSONL traces, and Python agent decisions.

This is an internal OWA model-to-browser feature. OWA will not become an MCP server in this work.

## Current State

`SimpleReActAgent` currently renders `BrowserToolDefinition[]` into its system prompt and instructs the model to return an `AgentDecision` JSON object. It then:

1. parses `ModelResponse.text` with `JSON.parse`;
2. normalizes common field aliases;
3. validates the complete value with `AgentDecisionSchema`;
4. returns the decision to `RunOrchestrator`;
5. lets the orchestrator execute nested `BrowserToolCall` values through the selected `ToolAdapter`.

`ModelRequest` has no tool definitions, and `ModelResponse` has no structured tool calls. Provider clients therefore discard or cannot represent provider-native tool calls.

The existing architecture already has useful boundaries:

- browser calls are closed Zod contracts;
- each environment has one tool adapter;
- each run receives a fixed `RuntimeContext`;
- browser events and action results already retain tool IDs and execution output.

The design extends those boundaries instead of replacing them with a generic tool runtime.

## Design Decision

### Selected approach

Add a provider-neutral tool protocol to the model contract and a capability-aware catalog to the browser tool adapter. Convert validated native model calls into the existing `BrowserToolCall` and `AgentDecision` contracts before orchestration.

This keeps the runtime, event stream, browser implementation, and Python agent protocol stable while moving tool selection from prompt-only JSON generation to provider-native structured calls.

### Alternatives rejected

#### Extend only `SimpleReActAgent`

Provider parsing, capability checks, conversation serialization, and browser conversion would become coupled to one agent. Other agents and future model transports would need to duplicate the behavior.

#### Replace `AgentDecision` with a generic tool decision

This would require a broader redesign of the orchestrator, event contracts, Python agents, approval behavior, and replay format. The current requirement is browser tool calling, so a generic non-browser tool runtime is out of scope.

## Model Contracts

`packages/core/src/contracts/model.ts` will add Zod-backed provider-neutral contracts:

```ts
interface ModelToolDefinition {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  strict?: boolean
}

interface ModelToolCall {
  id: string
  name: string
  arguments: unknown
}

interface ModelToolResult {
  toolCallId: string
  name: string
  output: unknown
  isError: boolean
}
```

`arguments` remains `unknown` until the browser catalog validates it. Provider responses are untrusted, and a compatibility endpoint may return malformed JSON or a non-object value despite receiving a function schema.

`ModelRequest` gains:

```ts
tools?: ModelToolDefinition[]
toolChoice?: "auto" | "none"
```

`ModelResponse` gains:

```ts
toolCalls: ModelToolCall[]
```

The default is an empty array so existing fake models and callers can migrate without changing behavior.

`ModelMessage` gains optional provider-neutral tool conversation fields:

```ts
toolCalls?: ModelToolCall[] // assistant message
toolCallId?: string        // tool result message
name?: string              // tool result message
```

Role-sensitive validation will enforce:

- `toolCalls` may appear only on an assistant message;
- `toolCallId` may appear only on a tool message;
- a tool result message must have both `toolCallId` and `name`;
- normal user and system messages cannot impersonate tool results.

The internal message content remains text or existing multimodal content parts. Tool result output is JSON-serialized into message content by the agent before it reaches a provider serializer.

## Provider Serialization

### OpenAI-compatible Chat Completions

The shared `OpenAICompatibleClient` remains the transport for:

- OpenAI API-key models;
- OpenRouter models;
- Claude through Anthropic's OpenAI-compatible endpoint;
- Gemini through Google's OpenAI-compatible endpoint.

Requests serialize `ModelRequest.tools` as Chat Completions function tools:

```json
{
  "type": "function",
  "function": {
    "name": "browser_navigate",
    "description": "Navigate the current page to an HTTP(S) URL.",
    "parameters": {
      "type": "object",
      "properties": {
        "url": { "type": "string" }
      },
      "required": ["url"],
      "additionalProperties": false
    }
  }
}
```

Assistant history with tool calls is serialized as `message.tool_calls`. Tool results are serialized as `role: "tool"` messages with `tool_call_id`.

Response parsing reads every `choices[0].message.tool_calls` entry, preserves its provider call ID, parses the function argument JSON when possible, and places malformed argument text in `ModelToolCall.arguments` for catalog validation to reject.

The first release does not add provider-specific Anthropic Messages or Gemini `generateContent` clients. The provider-neutral contracts allow those codecs to be added later without changing agents or the browser runtime.

### OpenAI Responses

`OpenAIResponsesClient` maps the same definitions to Responses API function tools.

Assistant tool calls are replayed as `function_call` input items. Tool results are replayed as `function_call_output` items correlated by `call_id`. Response parsing reads `function_call` output items and keeps `output_text` handling for final text.

### Strict schemas

Local Zod validation is authoritative. `strict` is transport guidance, not a security guarantee. A provider serializer may omit unsupported optional schema hints, but it must always send the JSON Schema parameters and return all calls through the common untrusted `ModelToolCall` contract.

## Browser Capability Model

The public capability names are:

```ts
type BrowserCapability =
  | "core"
  | "network"
  | "storage"
  | "testing"
  | "vision"
  | "pdf"
  | "devtools"
  | "config"
```

Rules:

- `core` is always enabled and cannot be disabled;
- omitted configuration resolves to `["core"]`;
- duplicate names are removed;
- unknown names are configuration errors;
- requesting a known capability that the selected adapter does not implement is a startup error;
- only `core` is implemented in the first release.

The larger enum makes the stable configuration vocabulary match the intended Playwright-style groups. It does not claim that unimplemented groups are available.

## Browser Tool Catalog

`BrowserToolDefinition` remains serializable and gains:

```ts
name: string
capability: BrowserCapability
inputSchema: Record<string, unknown>
readOnly: boolean
```

The existing `type`, `description`, `parameters`, and `example` fields remain for compatibility with prompt rendering, external Python agent context, tests, and diagnostics.

The executable browser package maintains an internal descriptor for each tool:

```ts
interface BrowserToolDescriptor {
  definition: BrowserToolDefinition
  argumentsSchema: z.ZodType
  toBrowserToolCall(callId: string, argumentsValue: unknown): BrowserToolCall
}
```

The argument Zod schema is the source of truth:

```text
Zod argument schema
  -> z.toJSONSchema() for ModelRequest.tools
  -> parse() before BrowserToolCall construction
```

The serializable `parameters` and `example` fields are projections or fixtures attached to the same descriptor. They must not introduce a second validation path.

`ToolAdapter` gains capability-aware operations:

```ts
interface ToolAdapter {
  supportedCapabilities: BrowserCapability[]
  listTools(capabilities: BrowserCapability[]): BrowserToolDefinition[]
  parseToolCall(
    call: ModelToolCall,
    capabilities: BrowserCapability[],
  ): BrowserToolCall
  validateToolCall(
    call: BrowserToolCall,
    capabilities: BrowserCapability[],
  ): BrowserToolCall
  modelToolName(call: BrowserToolCall): string
  execute(call: BrowserToolCall, ctx: RuntimeContext): Promise<ActionResult>
}
```

`parseToolCall` validates the external name, enabled capability, call ID, and arguments before constructing a closed `BrowserToolCall`.

`validateToolCall` applies the same capability and argument policy to legacy JSON decisions. This prevents the fallback path from bypassing the active tool set.

## Core Tool Mapping

The current browser operations are exposed with Playwright-inspired names:

| External model tool | Internal type | Capability |
|---|---|---|
| `browser_navigate` | `navigate` | `core` |
| `browser_click` | `click` | `core` |
| `browser_type` | `type` | `core` |
| `browser_scroll` | `scroll` | `core` |
| `browser_wait_for` | `wait` | `core` |
| `browser_press_key` | `press_key` | `core` |
| `browser_take_screenshot` | `screenshot` | `core` |
| `browser_extract_text` | `extract_text` | `core` |
| `browser_navigate_back` | `go_back` | `core` |
| `browser_navigate_forward` | `go_forward` | `core` |

These names do not imply exact Playwright MCP parity. In particular, the existing `extract_text` operation is not renamed to `browser_snapshot`, because OWA does not yet produce Playwright's accessibility snapshot format.

The model-facing arguments exclude internal fields such as `id` and `type`. The catalog adds those fields after validation.

## Configuration

The user configuration adds:

```yaml
browser_capabilities:
  - core
```

The environment override is:

```text
OPEN_WEB_AGENT_BROWSER_CAPABILITIES=core
```

Environment configuration takes precedence over YAML. The comma-separated environment value is trimmed, deduplicated, and normalized with `core` prepended.

Future capability implementations can be enabled by adding names such as `storage,testing` without changing the configuration shape. In the first release, configuring one of those known but unimplemented names fails explicitly.

`ModelConfig` gains `browserCapabilities`. `startDefaultRuntime` validates the resolved list against the default tool adapter before starting the server. `RunOrchestrator` repeats adapter support validation when a run selects an environment, so a non-default environment cannot receive incompatible capabilities.

Each run copies the resolved values into immutable run context:

```ts
RuntimeContext {
  browserCapabilities: BrowserCapability[]
  browserTools: BrowserToolDefinition[]
}
```

`run.started` includes the capability names and exposed model tool names in its payload. The event type and event schema do not change because event payloads are already open records.

## Agent Tool Loop

`SimpleReActAgent` sends the active browser definitions in `ModelRequest.tools` with `toolChoice: "auto"`. Tool descriptions replace most of the hand-written tool schema text in the system prompt. The prompt retains the trust boundary, safety policy, and decision rules.

The response selection order is:

1. if `ModelResponse.toolCalls` is non-empty, use the native tool path;
2. otherwise, if response text parses as a valid `AgentDecision`, use the existing JSON fallback;
3. otherwise, treat non-empty ordinary text as a `final_answer`;
4. if text looks like attempted decision JSON but is invalid, use the existing correction retry instead of silently converting it into a final answer.

### Native call conversion

All calls in one model response are validated before any are returned to the orchestrator. A valid call becomes one browser action containing one browser tool call:

```text
ModelToolCall
  -> BrowserAction
       id = derived from call ID
       kind = external tool name
       reason = model response text or null
       requiresApproval = tool policy result
       toolCalls = [validated BrowserToolCall]
```

One call per action preserves call/result correlation and leaves room for per-tool approval policies. Multiple calls remain in provider order and the orchestrator executes them sequentially. Browser operations are not parallelized because they mutate shared page state.

The provider call ID becomes `BrowserToolCall.id` and remains unchanged through browser events and model tool results.

### Approval ownership

The model does not author approval requirements in the native path. The browser tool descriptor or runtime policy determines `requiresApproval`; all first-release core tools default to the existing no-approval behavior.

Legacy JSON decisions are normalized through the same policy before execution. A model-provided `requiresApproval` value cannot weaken a policy-owned approval requirement.

The normalized value is recomputed from policy rather than trusted from model output. A model therefore cannot either bypass or invent an approval boundary.

### Invalid native calls

Unknown names, disabled capabilities, malformed arguments, and invalid IDs are rejected before browser execution.

`SimpleReActAgent.step()` gives the model one correction attempt using structured error results. If one response contains multiple calls and any call is invalid, none of the calls execute. The correction conversation supplies a result for every call ID:

- invalid calls receive their specific validation error;
- otherwise valid calls receive `not_executed_due_to_invalid_batch`.

This satisfies provider conversation requirements that every assistant tool call receives a corresponding tool result and prevents partially executing an invalid batch.

After the correction attempt, another invalid native batch fails the agent step with a concrete validation error.

## Conversation Reconstruction

Agent instances remain stateless across runs. Native tool conversation history is rebuilt from `AgentState.steps`, not stored on `SimpleReActAgent`.

`AgentStepRecord` gains:

```ts
modelToolResults: ModelToolResult[]
```

The orchestrator appends one model result when each browser tool completes:

```ts
{
  toolCallId: browserToolCall.id,
  name: toolAdapter.modelToolName(browserToolCall),
  output: {
    ok: actionResult.ok,
    message: actionResult.message,
    observation: actionResult.observation,
    metadata: actionResult.metadata,
  },
  isError: !actionResult.ok,
}
```

The next model request reconstructs:

```text
system policy and active tool definitions
user task and initial observation
assistant tool calls from previous browser_actions decisions
tool result for each completed call
user message containing the latest browser observation
```

Every previous `browser_actions` decision can be represented canonically as assistant tool calls, including decisions originally produced by the JSON fallback. This avoids adding provider-origin metadata to `AgentDecision` and permits a JSON-producing response to return to native tool calling on a later step.

Tool outputs are bounded by the same observation formatting and redaction rules used for agent prompts. The complete raw screenshot bytes or raw provider response are never inserted into textual tool results.

## Orchestrator Behavior

The orchestrator continues to own browser execution. Before emitting `browser.tool.started`, it calls `validateToolCall` for every `BrowserToolCall`, including calls from Python agents and JSON fallback decisions.

This is a defense-in-depth check. Agent-level validation improves repair behavior, while orchestrator-level validation prevents another agent implementation from bypassing the configured capability set.

Execution failures remain ordinary `ActionResult` failures:

- locator failure;
- Playwright timeout;
- blocked navigation;
- browser closure;
- cancellation.

They are recorded in existing browser events and returned as `ModelToolResult` values on the next model turn. Existing action failure short-circuit behavior remains unchanged.

## Error Model

Validation errors use stable internal codes:

- `unknown_tool`
- `capability_disabled`
- `invalid_tool_call_id`
- `invalid_tool_arguments`
- `unsupported_capability`
- `not_executed_due_to_invalid_batch`

The model-facing error output has this shape:

```json
{
  "code": "invalid_tool_arguments",
  "message": "browser_click requires a target",
  "issues": []
}
```

Zod issue details are reduced to safe paths, codes, and messages. Provider payloads and secrets are not included.

Configuration errors fail runtime startup. Agent call validation errors use the bounded correction loop. Browser execution errors remain recoverable action results. Abort errors remain authoritative and are never converted into model tool results.

## Trace and Redaction

Existing event types remain sufficient:

- `agent.step.completed` stores the normalized `AgentDecision`;
- `browser.tool.started` stores the internal browser call;
- `browser.tool.completed` stores the call and `ActionResult`;
- `model.called` stores provider metadata and exposed tool count;
- `model.completed` stores response mode, tool names, call IDs, usage, and latency.

`model.completed` does not store the raw provider response or raw function arguments. Browser events already contain validated arguments.

The redaction layer must recognize model-facing `browser_type` arguments in addition to the internal `{ type: "type", value }` shape. Typed values and fields with sensitive names are redacted before events, traces, or model-visible history are written.

## Compatibility and Migration

- `AgentDecision` remains the runtime decision contract.
- `BrowserToolCall` remains the execution contract.
- Existing browser event names and JSONL event schema remain unchanged.
- Existing JSON decision parsing remains available.
- Existing Python agents can continue returning `AgentDecision`.
- Python agents receive the richer serializable browser definitions and active capabilities in runtime context.
- Existing configuration files resolve to `core` without modification.
- Existing traces remain readable because new payload and step fields are additive at runtime.
- No existing browser tool is removed.

Fake `ModelPlugin` implementations must return `toolCalls: []` after the contract migration. Where compatibility at parse boundaries is required, the Zod response schema supplies that default.

## Testing

### Core contracts

- accept valid tool definitions, calls, results, and role-sensitive messages;
- reject tool-result messages without call IDs;
- preserve old model requests and responses through defaults;
- generate JSON Schema from each core argument Zod schema.

### Capability configuration

- default to `core`;
- normalize YAML and environment values;
- apply environment precedence;
- deduplicate names;
- reject unknown capability names;
- reject known but adapter-unsupported capabilities at startup.

### Browser catalog

- list only tools enabled for a capability set;
- map each external core name to the expected internal type;
- preserve provider call IDs;
- reject unknown or disabled tools;
- reject invalid arguments;
- validate legacy internal browser calls through the same capability rules.

### OpenAI-compatible transport

- serialize function tools and `tool_choice`;
- serialize assistant tool calls and correlated tool messages;
- parse one and multiple response tool calls;
- preserve mixed text and tool calls;
- retain malformed arguments for local rejection;
- keep ordinary text completion behavior.

The same transport tests cover OpenAI, OpenRouter, Claude-compatible, and Gemini-compatible model wrappers.

### Responses transport

- serialize function tools;
- replay `function_call` and `function_call_output` items;
- parse function calls and output text;
- correlate calls by `call_id`.

### Agent

- native call to `browser_actions` conversion;
- one action per call and provider-order preservation;
- policy-owned approval values;
- invalid batch correction without execution;
- failure after the correction limit;
- JSON decision fallback;
- ordinary text final answer;
- canonical reconstruction of prior assistant calls and tool results.

### Orchestrator and integration

- execute multiple native calls sequentially;
- append one correlated `ModelToolResult` per completed browser call;
- block a disabled tool supplied by a non-native agent;
- preserve browser event call IDs;
- expose capabilities and tool names at run start;
- redact typed and sensitive arguments;
- complete an end-to-end run with a fake provider returning native tool calls followed by a final answer.

### Verification

```bash
bun run typecheck
bun run test
```

## Non-Goals

- Exposing OWA as an MCP server.
- Implementing `network`, `storage`, `testing`, `vision`, `pdf`, `devtools`, or `config` tools.
- Adding Anthropic Messages or Gemini `generateContent` transports.
- Creating a generic non-browser tool runtime.
- Parallel browser tool execution.
- Persisting raw provider responses in traces.
- Automatically retrying a provider that rejects the `tools` request parameter.
- Claiming exact behavioral or naming parity with Playwright MCP.

## References

- [Playwright MCP capabilities](https://playwright.dev/mcp/capabilities)
- [Playwright MCP repository](https://github.com/microsoft/playwright-mcp)
- [OpenAI function calling](https://developers.openai.com/api/docs/guides/function-calling)
- [Claude tool use](https://docs.anthropic.com/en/docs/build-with-claude/tool-use/overview)
- [Gemini function calling](https://ai.google.dev/gemini-api/docs/function-calling)

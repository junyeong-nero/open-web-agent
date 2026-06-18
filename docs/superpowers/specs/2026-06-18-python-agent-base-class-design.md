# Python Agent Base Class Design

## Goal

Make project-local Python agents under `agents/` easier to customize without weakening the existing runtime boundary.

The current examples expose too much protocol detail in each `main.py`: lifecycle dispatch, JSONL I/O, model command envelopes, event emission, browser tool-call shapes, and final decision JSON. The new API should let users edit a small class and focus on browser-control behavior, while still allowing advanced users to return raw protocol-compatible dictionaries when needed.

## Scope

This work adds a Python convenience layer only. It does not change the TypeScript `AgentPlugin` contract, the `PythonAgentAdapter` JSONL protocol, model provider configuration, browser environments, or the `agent.yaml` registration format.

Existing Python agents remain compatible. The new class API is additive, and the current low-level `_common.protocol` helpers remain available as an escape hatch.

## Recommended Approach

Add `agents/_common/agent.py` with four small units:

- `BaseAgent`: handles lifecycle dispatch for `initialize`, `step`, and `finalize`, reads the request, emits the final response, and reports unsupported methods consistently.
- `AgentContext`: wraps the lifecycle request and exposes stable, readable accessors for `state`, `prompt`, `last_observation`, `steps`, `run_dir`, selected runtime ids, and failure inspection.
- `ModelClient`: wraps the existing JSONL `model.complete` command with `complete_text`, `complete_json`, and a lower-level `complete` method.
- Decision helpers: build valid `AgentDecision` dictionaries for final answers and browser actions, with helpers for common browser tool calls.

The target user experience is:

```python
from _common.agent import BaseAgent


class MyAgent(BaseAgent):
    def step(self, ctx):
        if ctx.is_blank_page:
            return ctx.actions.navigate("open_target", ctx.target_url_or("https://example.com"))

        model_json = ctx.model.complete_json(
            system="You control a browser. Return an AgentDecision JSON object.",
            user=ctx.observation_text(),
        )
        return ctx.decision.from_model(model_json)


if __name__ == "__main__":
    MyAgent().run()
```

## API Shape

`BaseAgent` provides default behavior:

- `initialize(self, ctx)` returns `{"ok": True}`.
- `step(self, ctx)` is intentionally abstract and must be implemented by each concrete agent.
- `finalize(self, ctx)` returns `ctx.final_answer or ""`.
- `run(self)` handles request parsing and response emission.

`AgentContext` provides convenience properties and methods:

- `prompt`, `state`, `steps`, `last_observation`, `final_answer`
- `context`, `run_dir`, `agent_id`, `model_id`, `environment_id`
- `is_blank_page`
- `last_step_failed()`
- `failed_action_messages()`
- `observation_text(limit_elements=20)`
- `target_url_or(default=None)` using the URL/domain extraction behavior currently embedded in `text-vision-mixed-grounding`
- `screenshot_data_url()` for screenshot-backed model requests

`ModelClient` methods:

- `complete(request, command_id=None)` sends a raw model request.
- `complete_text(system, user, temperature=0, **kwargs)` returns model text.
- `complete_json(system, user, temperature=0, **kwargs)` requests JSON and parses the returned text as an object.

Decision helpers:

- `ctx.final_answer(text, thought=None, confidence=1)`
- `ctx.browser_action(action_id, tool_calls, kind=None, reason=None, requires_approval=False)`
- `ctx.actions.navigate(action_id, url, reason=None)`
- `ctx.actions.click(action_id, selector=None, element_id=None, text=None, role=None, name=None, reason=None)`
- `ctx.actions.type(action_id, value, selector=None, element_id=None, text=None, role=None, name=None, reason=None)`
- `ctx.actions.screenshot(action_id="capture_screenshot", reason=None)`
- `ctx.actions.extract_text(action_id="extract_text", reason=None)`
- `ctx.actions.wait(action_id, ms, reason=None)`
- `ctx.actions.press_key(action_id, key, reason=None)`
- `ctx.decision.from_model(value)` normalizes common model aliases through the existing protocol normalization logic.

The `ctx.actions.*` helpers are high-level convenience methods: each returns a complete `browser_actions` decision containing one browser action and one tool call. Users who need multiple tool calls in a single browser action can call lower-level `ctx.tool_calls.*` helpers and wrap them with `ctx.browser_action(...)`.

Helpers return plain dictionaries matching the TypeScript Zod contracts. That keeps Python free of a generated client or package install step.

## Data Flow

The TypeScript runtime continues to spawn `python3 main.py` for each lifecycle call. In `protocol: jsonl` mode:

1. The adapter writes one lifecycle request line to stdin.
2. `BaseAgent.run()` reads that request and creates an `AgentContext`.
3. User code returns either a plain decision dict or a response wrapper containing `events` and `decision`.
4. `BaseAgent` writes the final lifecycle response line to stdout.
5. When user code calls `ctx.model.*`, `ModelClient` writes a `model.complete` command line and waits for the adapter response.

This preserves the existing centralization of provider configuration, model events, cancellation, storage, and schema validation in TypeScript.

## Events

User agents need a simple way to emit plan/status events without hand-writing the full response shape. The new API should support either of these forms:

```python
ctx.events.plan_created(items)
return ctx.actions.navigate("open", url)
```

or:

```python
return ctx.with_events(
    events=[{"type": "plan.created", "payload": {"items": items}}],
    decision=ctx.actions.navigate("open", url),
)
```

Internally both forms produce the existing `{"events": [...], "decision": ...}` lifecycle response. Raw event dictionaries remain accepted.

## Example Migration

Refactor `agents/plan-act/main.py` to subclass `BaseAgent`.

The refactor should keep the same behavior:

- create a visible plan on the first step;
- update the plan after browser action failure;
- call the selected runtime model for planning and decision JSON;
- retry invalid model decision JSON once;
- return the current final answer from `finalize`.

Refactor `agents/text-vision-mixed-grounding/main.py` to subclass `BaseAgent`.

The refactor should keep the same behavior:

- navigate to a URL/domain from the prompt when needed;
- collect screenshot and extracted text before grounding;
- convert screenshot artifacts into a data URL;
- call the selected runtime model with text and image content;
- return a concise final answer.

## Error Handling

The convenience layer should fail loudly when the user returns an invalid value:

- missing lifecycle input raises `RuntimeError`;
- unsupported lifecycle method exits with a clear message;
- model command failures raise `RuntimeError` with the adapter-provided error;
- `complete_json` raises `RuntimeError` on invalid or non-object JSON;
- missing screenshot file raises the native file error with the path visible;
- invalid final response shape remains validated by the TypeScript adapter.

The helper layer should not swallow schema errors or silently fall back to mock content.

## Testing

Add focused tests through the existing Bun test suite that spawn temporary Python agents or load the project-local examples:

- a Python fixture using `BaseAgent` can return a final answer;
- a Python fixture using `ctx.model.complete_json` delegates through the adapter model;
- a Python fixture using action helpers returns valid browser action decisions;
- existing manifest loading still supports low-level Python agents;
- `agents/plan-act` remains registered and emits plan events;
- `agents/text-vision-mixed-grounding` still requests observation actions before model grounding.

Verification commands:

```bash
bun test packages/agents/src/python-agent-adapter.test.ts packages/agents/src/python-agent-manifest.test.ts packages/server/src/default-runtime.test.ts
bun run typecheck
```

## Non-Goals

- No new Python package distribution or installation step.
- No generated Python types from Zod schemas.
- No declarative YAML agent builder.
- No changes to model provider selection or browser tool execution.
- No authentication or server boundary changes.

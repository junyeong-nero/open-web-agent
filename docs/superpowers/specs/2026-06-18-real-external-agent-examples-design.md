# Real External Agent Examples Design

## Goal

Make `agents/` examples behave like real runtime agents instead of deterministic browser-only demos.

The change should:
- expose the existing model-backed plan-act pattern as a project-local external agent under `agents/plan-act`;
- update `agents/text-vision-mixed-grounding` so it uses extracted text and screenshot image content in a model call;
- keep TypeScript runtime ownership of model selection, model lifecycle events, browser execution, cancellation, validation, traces, and storage.

## Current Problem

Python agents currently receive one JSON request on stdin and return one JSON response on stdout. They can emit events and return `browser_actions` or `final_answer`, but they cannot call the selected runtime model. Because of that, `text-vision-mixed-grounding` can only check whether `lastObservation.text` and `lastObservation.screenshotPath` exist, then return a canned answer.

The built-in `PlanActAgent` already does the desired structure:
1. call the selected runtime model for a visible plan;
2. emit `plan.created` or `plan.updated`;
3. call the selected runtime model again for the browser decision.

That structure should be demonstrable from `agents/` without duplicating provider clients in Python.

## Architecture

Extend `PythonAgentAdapter` with an opt-in request-response protocol loop. Existing agents keep the current one-shot protocol, where the adapter writes one JSON object to stdin, closes stdin, and parses stdout as the final lifecycle response.

Model-backed external agents set `protocol: jsonl` in `agent.yaml`. In that mode, each Python process invocation receives one newline-delimited lifecycle request on stdin and writes newline-delimited JSON on stdout. It may first write one or more command envelopes:

```json
{"command":"model.complete","id":"model_1","request":{...}}
```

For each command, the adapter calls `ctx.model.complete(request, ctx)` indirectly through an injected `model` option and writes one JSON line to the child stdin:

```json
{"id":"model_1","ok":true,"response":{...}}
```

The final stdout line remains the lifecycle response shape already used today. This keeps existing simple agents compatible while allowing real model-backed external agents.

`RuntimeSelectedModel` already emits `model.called` and `model.completed`, so delegated Python model calls keep the same model selection and observability as built-in agents.

## Components

### Python Agent Adapter

`PythonAgentAdapterOptions` gains optional `model?: ModelPlugin` and `protocol?: "oneshot" | "jsonl"` fields.

The default `oneshot` path keeps the existing `child.stdin.end(JSON.stringify(request))` behavior. The `jsonl` path:
1. spawn the process;
2. write the lifecycle request as a single newline-delimited JSON object;
3. read stdout line by line;
4. handle command envelopes until a final lifecycle response line is received;
5. validate the final lifecycle response exactly as before.

If no model is configured and a Python agent sends `model.complete`, the adapter returns an error response. The Python script may turn that into a final failure answer, but the adapter should not silently fall back to mock content.

### External Plan-Act Agent

Create `agents/plan-act/agent.yaml` and `agents/plan-act/main.py`.

The Python agent mirrors the built-in `PlanActAgent`:
- first step calls `model.complete` to create a plan JSON;
- emits `plan.created`;
- calls `model.complete` again to choose a browser action or final answer;
- after a failed previous browser action, replans and emits `plan.updated`.

The external agent should use the same `AgentDecision` JSON contract as the built-in agent. It should repair common model tool-call aliases enough for example use, but should not become a broad framework.

### Text-Vision Mixed Grounding Agent

Update `agents/text-vision-mixed-grounding/main.py`.

Behavior:
- if no text or screenshot exists, request browser `screenshot` and `extract_text`;
- if a URL is present in the prompt or the browser is blank, navigate before capturing;
- once text and screenshot exist, call `model.complete` with text and a screenshot data URL in an OpenAI-compatible multimodal message payload;
- return the model's answer as `final_answer`.

The core `ModelRequest` contract must allow message content to be either a string or a provider-compatible content part array. The OpenAI-compatible client should forward that structure unchanged.

## Error Handling

Python command envelopes use explicit success and failure responses. Adapter-level failures include command id, command type, and provider error message.

Invalid final lifecycle JSON remains an adapter error. Invalid model JSON in the external plan-act agent should trigger the agent's own retry prompt once, matching the built-in `SimpleReActAgent` behavior.

## Testing

Tests should be added before implementation:
- adapter test proving a Python script can request `model.complete` and receive the response;
- model contract/client test proving multimodal message content is preserved in chat completions request bodies;
- default runtime test proving `agents/plan-act` is registered from project-local manifests;
- CLI/runtime test proving `text-vision-mixed-grounding` asks the selected runtime model after screenshot and text are available.

Final verification remains:

```bash
bun run typecheck
bun test
```

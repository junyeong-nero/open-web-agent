# Python Agents

Project-local Python agents live under:

```text
agents/<agent-id>/agent.yaml
```

The default TUI and headless `run` commands load manifests from the active project path. The lower-level `serve` command does not take a project path today, so it uses the runtime default agents directory under `OWA_HOME`.

## Manifest

Minimal manifest shape:

```yaml
id: my-agent
name: My Agent
description: Optional description
language: python
entry: main.py
protocol: oneshot # or jsonl
```

`oneshot` agents receive one lifecycle request on stdin and return one JSON response.

`jsonl` agents can also request `model.complete` calls from the TypeScript runtime, so provider selection, model lifecycle events, cancellation, and traces stay owned by the runtime.

Shared Python helpers are available in `agents/_common`. The included examples demonstrate a plan-act model loop, AgentOccam-style browser commands, and mixed text/screenshot grounding.


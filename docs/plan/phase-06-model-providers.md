# Phase 6: Model Providers

[Back to plan index](../plan.md)

## Phase Summary

Goal: connect real providers behind the `ModelPlugin` contract.

Implement after Sprint 1:

```text
packages/models/src/openai-compatible-client.ts
packages/models/src/openai-model.ts
packages/models/src/openrouter-model.ts
packages/models/src/model-config.ts
```

Provider config:

```text
OPENAI_API_KEY for OpenAI
OPENROUTER_API_KEY for OpenRouter
OPEN_WEB_AGENT_MODEL for default model selection
```

Verification:

```bash
bun test packages/models
```

Expected result:

```text
Provider request construction is tested without network calls.
Live provider smoke tests run only when the matching API key is present.
```

# Phase 7: SimpleReActAgent

[Back to plan index](../plan.md)

## Phase Summary

Goal: use real model decisions to generate browser actions.

Implement after model providers:

```text
observation-to-prompt formatter
browser action schema prompt
model JSON parse and Zod validation
one retry for parse failure
max step limit
timeout handling
final answer generation
```

Verification:

```bash
bun test packages/agents
```

Expected result:

```text
Simple page-title and text-extraction tasks complete with Playwright + selected model.
Invalid model decisions produce run.failed with raw model output in event payload.
```

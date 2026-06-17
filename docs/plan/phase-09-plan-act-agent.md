# Phase 9: PlanActAgent

[Back to plan index](../plan.md)

## Phase Summary

Goal: add explicit planning and progress visibility.

Implement after SimpleReActAgent:

```text
plan.created event
plan.updated event
plan generation prompt
action selection prompt
replan policy after browser action failure
TUI planning view in inspector
```

Verification:

```bash
bun test packages/agents packages/tui
```

Expected result:

```text
During a run, active/completed/pending plan items are visible.
Browser action failure can trigger a replan event before the run fails.
```

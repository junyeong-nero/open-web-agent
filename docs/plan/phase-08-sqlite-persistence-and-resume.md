# Phase 8: SQLite Persistence And Resume

[Back to plan index](../plan.md)

## Phase Summary

Goal: persist sessions and run metadata across app restarts.

Implement after mock TUI/server flow is stable:

```text
packages/storage/src/sqlite-store.ts
sessions table
runs table
messages table
/sessions list route
/sessions selector in TUI
--continue flag
--session <id> flag
session Markdown export
```

Verification:

```bash
bun test packages/storage packages/server packages/tui
```

Expected result:

```text
Restarting the app can list and reopen previous sessions.
Run timeline and final answers can be loaded from persisted metadata and JSONL traces.
```

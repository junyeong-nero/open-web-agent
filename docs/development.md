# Development

This is a Bun monorepo. Use `bun`, not `npm` or `yarn`.

```bash
bun install
bun run typecheck
bun run test
OPEN_WEB_AGENT_BROWSER_HEADLESS=true bun test packages/core/src/events/event-bus.test.ts
OPEN_WEB_AGENT_BROWSER_HEADLESS=true bun test packages/*/src -t "publishes events"
```

Always run `bun run typecheck` after changes. Tests that exercise orchestrator or storage paths should set `OWA_HOME` to a temp directory so local developer data is not touched.

# Phase 3: Local Server

[Back to plan index](../plan.md)

## Phase Summary

Goal: expose the mock runtime through Hono routes and SSE.

Implement:

```text
packages/server/src/app.ts
packages/server/src/start-server.ts
packages/server/src/routes/health.ts
packages/server/src/routes/events.ts
packages/server/src/routes/sessions.ts
packages/server/src/routes/runs.ts
packages/server/src/routes/plugins.ts
packages/server/src/schemas/api.ts
```

Verification:

```bash
bun test packages/server
bun run typecheck
```

Expected result:

```text
GET /health returns { "ok": true }.
POST /sessions creates an in-memory session.
POST /runs starts a mock run.
GET /events streams live RunEvent SSE messages.
POST /runs/:runId/cancel marks an active run cancelled.
```

## Sprint 1 Detailed Tasks

### Task 5: Hono Local Server

**Files:**

```text
Create: packages/server/src/app.ts
Create: packages/server/src/start-server.ts
Create: packages/server/src/index.ts
Create: packages/server/src/routes/health.ts
Create: packages/server/src/routes/events.ts
Create: packages/server/src/routes/sessions.ts
Create: packages/server/src/routes/runs.ts
Create: packages/server/src/routes/plugins.ts
Create: packages/server/src/schemas/api.ts
Create: packages/server/src/app.test.ts
```

- [ ] Implement `createApp(deps)`.

Required dependencies:

```text
eventBus
orchestrator
registry
sessionStore in memory
runResults map for started.result promises
```

Use this dependency shape:

```ts
import type { EventBus, PluginRegistry, RunOrchestrator, SessionState } from "@open-web-agent/core"

export interface CreateAppDeps {
  eventBus: EventBus
  orchestrator: RunOrchestrator
  registry: PluginRegistry
  sessions: Map<string, SessionState>
}
```

Do not add auth middleware in Sprint 1.

- [ ] Implement `startServer(options)`.

Public API:

```ts
export interface StartServerOptions {
  app: Hono
  hostname?: string
  port?: number
}

export interface StartedServer {
  url: string
  hostname: string
  port: number
  stop(): Promise<void>
}
```

Behavior:

```text
Default hostname is 127.0.0.1.
Default port is 0 so Bun chooses an available local port.
Reject hostnames other than 127.0.0.1 and localhost in Sprint 1.
Use Bun.serve({ hostname, port, fetch: app.fetch }).
Return the resolved local URL and a stop() wrapper around server.stop().
```

- [ ] Implement `GET /health`.

Response:

```json
{ "ok": true }
```

- [ ] Implement `POST /sessions`.

Request:

```json
{ "projectPath": "/absolute/project/path" }
```

Response:

```json
{ "sessionId": "ses_..." }
```

- [ ] Implement `POST /runs`.

Request:

```json
{
  "sessionId": "ses_...",
  "prompt": "example.com에 접속해서 페이지 제목을 알려줘"
}
```

Response:

```json
{ "runId": "run_..." }
```

Route behavior:

```text
Validate that sessionId exists.
Call const started = orchestrator.startRun({ session, prompt }).
Attach started.result.catch(...) so background failures are not unhandled promise rejections.
Return { runId: started.runId } immediately without waiting for the run to complete.
```

- [ ] Implement `GET /events` with Hono `streamSSE`.

Required behavior:

```text
Every EventBus event is written as one SSE message.
SSE event name equals RunEvent.type.
SSE id equals RunEvent.sequence as a string.
SSE data is the full RunEvent JSON.
Disconnect unsubscribes the EventBus listener.
```

- [ ] Implement `POST /runs/:runId/cancel`.

Response when active:

```json
{ "cancelled": true }
```

Response when unknown:

```json
{ "cancelled": false }
```

- [ ] Add server tests.

Test names:

```text
GET /health returns ok
POST /sessions creates a session
POST /runs starts a mock run
GET /plugins lists registered mock plugins
POST /runs/:runId/cancel returns cancelled false for an unknown run
POST /runs/:runId/cancel cancels an active delayed run
```

The active cancellation test must start a run through `POST /runs`, immediately call `POST /runs/:runId/cancel`, then await the captured `started.result` promise or observed `run.cancelled` event.

- [ ] Run verification.

```bash
bun test packages/server
bun run typecheck
```

Expected:

```text
All server tests pass.
No TypeScript errors.
```

- [ ] Commit.

```bash
git add packages/server
git commit -m "[add] expose mock runtime over local server"
```

# Phase 0: Bun Monorepo Conversion

[Back to plan index](../plan.md)

## Phase Summary

Goal: remove the Python placeholder and create a compiling Bun/TypeScript workspace.

Delete:

```text
main.py
pyproject.toml
.python-version
```

Create:

```text
package.json
bunfig.toml
tsconfig.json
tsconfig.base.json
packages/*/package.json
packages/*/tsconfig.json
packages/*/src/index.ts
packages/browser/src/playwright-environment.ts
packages/agents/src/simple-react-agent.ts
packages/models/src/openai-compatible-client.ts
packages/models/src/openai-model.ts
packages/models/src/openrouter-model.ts
packages/models/src/model-config.ts
packages/storage/src/sqlite-store.ts
packages/storage/src/artifact-store.ts
```

Verification:

```bash
bun install
bun run typecheck
bun test
```

Expected result:

```text
No TypeScript errors.
No failing tests.
```

## Sprint 1 Detailed Tasks

### Task 1: Convert To Bun Workspace

**Files:**

```text
Delete: main.py
Delete: pyproject.toml
Delete: .python-version
Create: package.json
Create: bunfig.toml
Create: tsconfig.json
Create: tsconfig.base.json
Create: packages/cli/package.json
Create: packages/core/package.json
Create: packages/server/package.json
Create: packages/tui/package.json
Create: packages/browser/package.json
Create: packages/agents/package.json
Create: packages/models/package.json
Create: packages/storage/package.json
Create: packages/*/tsconfig.json
Create: packages/*/src/index.ts
Create: packages/browser/src/playwright-environment.ts
Create: packages/agents/src/simple-react-agent.ts
Create: packages/models/src/openai-compatible-client.ts
Create: packages/models/src/openai-model.ts
Create: packages/models/src/openrouter-model.ts
Create: packages/models/src/model-config.ts
Create: packages/storage/src/sqlite-store.ts
Create: packages/storage/src/artifact-store.ts
Modify: README.md
```

- [ ] Write root `package.json` with workspace scripts.

```json
{
  "name": "open-web-agent",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "workspaces": ["packages/*"],
  "scripts": {
    "typecheck": "tsc -b",
    "test": "bun test",
    "dev": "bun run packages/cli/src/index.ts",
    "owa": "bun run packages/cli/src/index.ts"
  },
  "devDependencies": {
    "@types/bun": "1.3.14",
    "typescript": "6.0.3"
  },
  "dependencies": {
    "@opentui/core": "0.4.1",
    "@opentui/solid": "0.4.1",
    "hono": "4.12.25",
    "solid-js": "1.9.13",
    "zod": "4.4.3"
  }
}
```

- [ ] Write `bunfig.toml` so OpenTUI Solid JSX works at runtime.

```toml
preload = ["@opentui/solid/preload"]
```

- [ ] Write root `tsconfig.json` with package references.

```json
{
  "files": [],
  "references": [
    { "path": "./packages/core" },
    { "path": "./packages/browser" },
    { "path": "./packages/agents" },
    { "path": "./packages/models" },
    { "path": "./packages/storage" },
    { "path": "./packages/server" },
    { "path": "./packages/tui" },
    { "path": "./packages/cli" }
  ]
}
```

- [ ] Write root `tsconfig.base.json`.

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "skipLibCheck": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "composite": true,
    "jsx": "preserve",
    "jsxImportSource": "@opentui/solid",
    "types": ["bun-types"]
  }
}
```

- [ ] Each package gets `package.json`, `tsconfig.json`, and `src/index.ts`.

Use these package names:

```text
@open-web-agent/cli
@open-web-agent/core
@open-web-agent/server
@open-web-agent/tui
@open-web-agent/browser
@open-web-agent/agents
@open-web-agent/models
@open-web-agent/storage
```

Package `package.json` pattern:

```json
{
  "name": "@open-web-agent/core",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "exports": {
    ".": "./src/index.ts"
  }
}
```

Package dependency map:

```text
@open-web-agent/core depends on zod.
@open-web-agent/browser depends on @open-web-agent/core.
@open-web-agent/agents depends on @open-web-agent/core.
@open-web-agent/models depends on @open-web-agent/core.
@open-web-agent/server depends on @open-web-agent/core, @open-web-agent/browser, @open-web-agent/agents, hono, zod.
@open-web-agent/tui depends on @open-web-agent/core, @opentui/core, @opentui/solid, solid-js, zod.
@open-web-agent/cli depends on @open-web-agent/core, @open-web-agent/server, @open-web-agent/tui.
@open-web-agent/storage has no runtime dependency in Sprint 1.
```

Use these exact dependency objects in package manifests:

```json
{
  "packages/core/package.json": {
    "dependencies": {
      "zod": "4.4.3"
    }
  },
  "packages/browser/package.json": {
    "dependencies": {
      "@open-web-agent/core": "workspace:*"
    }
  },
  "packages/agents/package.json": {
    "dependencies": {
      "@open-web-agent/core": "workspace:*"
    }
  },
  "packages/models/package.json": {
    "dependencies": {
      "@open-web-agent/core": "workspace:*"
    }
  },
  "packages/server/package.json": {
    "dependencies": {
      "@open-web-agent/agents": "workspace:*",
      "@open-web-agent/browser": "workspace:*",
      "@open-web-agent/core": "workspace:*",
      "hono": "4.12.25",
      "zod": "4.4.3"
    }
  },
  "packages/tui/package.json": {
    "dependencies": {
      "@open-web-agent/core": "workspace:*",
      "@opentui/core": "0.4.1",
      "@opentui/solid": "0.4.1",
      "solid-js": "1.9.13",
      "zod": "4.4.3"
    }
  },
  "packages/cli/package.json": {
    "dependencies": {
      "@open-web-agent/core": "workspace:*",
      "@open-web-agent/server": "workspace:*",
      "@open-web-agent/tui": "workspace:*"
    }
  },
  "packages/storage/package.json": {
    "dependencies": {}
  }
}
```

Package `tsconfig.json` pattern:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist"
  },
  "include": ["src/**/*.ts", "src/**/*.tsx"]
}
```

Package `src/index.ts` initial content:

```ts
export {}
```

Future-phase stub file content:

```ts
export {}
```

Create these stubs in Sprint 1 so later tasks can import stable paths without reshaping the repository:

```text
packages/browser/src/playwright-environment.ts
packages/agents/src/simple-react-agent.ts
packages/models/src/openai-compatible-client.ts
packages/models/src/openai-model.ts
packages/models/src/openrouter-model.ts
packages/models/src/model-config.ts
packages/storage/src/sqlite-store.ts
packages/storage/src/artifact-store.ts
```

- [ ] Run verification.

```bash
bun install
bun run typecheck
bun test
```

Expected:

```text
typecheck exits 0.
bun test exits 0 with no failing tests.
```

- [ ] Commit.

```bash
git add .
git commit -m "[chore] convert project to Bun workspace"
```

import { describe, expect, it } from "bun:test"
import { readFile } from "node:fs/promises"
import { resolve } from "node:path"

describe("workspace validation commands", () => {
  it("runs the all-test script headless from source directories only", async () => {
    const packageJson = JSON.parse(await readFile(resolve(import.meta.dir, "../../../package.json"), "utf8")) as {
      scripts?: Record<string, string>
    }

    expect(packageJson.scripts?.test).toBe("OPEN_WEB_AGENT_BROWSER_HEADLESS=true bun test packages/*/src")
  })

  it("keeps typecheck output declaration-only so Bun does not discover emitted tests", async () => {
    const tsconfig = JSON.parse(await readFile(resolve(import.meta.dir, "../../../tsconfig.base.json"), "utf8")) as {
      compilerOptions?: { emitDeclarationOnly?: boolean }
    }

    expect(tsconfig.compilerOptions?.emitDeclarationOnly).toBe(true)
  })
})

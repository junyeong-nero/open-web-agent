import { describe, expect, it } from "bun:test"
import { mkdtemp } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"

describe("CLI end-to-end smoke", () => {
  it("reports a missing model for the headless command without provider credentials", async () => {
    const home = await mkdtemp(join(tmpdir(), "owa-e2e-home-"))
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: home,
      OWA_HOME: home,
      PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH ?? defaultPlaywrightBrowsersPath(),
      OPEN_WEB_AGENT_BROWSER_HEADLESS: "true",
      OPEN_WEB_AGENT_CODEX_AUTH_PATH: join(home, "missing-codex-auth.json"),
    }
    for (const key of providerEnvKeys) {
      delete env[key]
    }
    const proc = Bun.spawn(
      ["bun", "run", "packages/cli/src/index.ts", "run", "example.com에 접속해서 페이지 제목을 알려줘"],
      {
        cwd: join(import.meta.dir, "../../.."),
        env,
        stdout: "pipe",
        stderr: "pipe",
      },
    )

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])

    expect(stderr).toBe("")
    expect(exitCode).toBe(0)
    expect(stdout).toContain("[run.failed] No model selected.")
  }, 20_000)
})

const providerEnvKeys = [
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
  "GEMINI_API_KEY",
  "ANTHROPIC_API_KEY",
  "OPEN_WEB_AGENT_MODEL",
  "OPEN_WEB_AGENT_MODEL_PROVIDER",
  "OPEN_WEB_AGENT_CODEX_ACCESS_TOKEN",
  "CODEX_ACCESS_TOKEN",
]

function defaultPlaywrightBrowsersPath(): string {
  if (process.platform === "darwin") return join(homedir(), "Library", "Caches", "ms-playwright")
  if (process.platform === "win32") {
    return join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "ms-playwright")
  }
  return join(homedir(), ".cache", "ms-playwright")
}

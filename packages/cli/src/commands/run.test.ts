import { describe, expect, it } from "bun:test"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { runCommand } from "./run"

describe("runCommand", () => {
  it("prints a model configuration failure when no model is configured", async () => {
    const lines: string[] = []
    const home = await mkdtemp(join(tmpdir(), "owa-cli-home-"))

    await runCommand(
      {
        prompt: "example.com에 접속해서 페이지 제목을 알려줘",
        projectPath: "/tmp/open-web-agent-project",
      },
      {
        env: {
          OWA_HOME: home,
          OPEN_WEB_AGENT_CODEX_AUTH_PATH: join(home, "missing-codex-auth.json"),
        },
        configPath: join(home, "missing-config.yaml"),
        stdout: (line) => lines.push(line),
      },
    )

    expect(lines).toContainEqual(expect.stringContaining("[run.started] run_"))
    expect(lines.at(-1)).toContain("[run.failed] No model selected.")
  })

  it("runs the project text-vision mixed grounding Python agent", async () => {
    const fixtureServer = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () =>
        new Response("<!doctype html><title>CLI Fixture</title><main>CLI fixture page text.</main>", {
          headers: { "content-type": "text/html" },
        }),
    })
    const fixtureUrl = `http://127.0.0.1:${fixtureServer.port}/`
    const originalFetch = globalThis.fetch
    const providerRequests: unknown[] = []
    globalThis.fetch = (async (input, init) => {
      const url = String(input instanceof Request ? input.url : input)
      if (url.startsWith("http://127.0.0.1") || url.startsWith("http://localhost")) {
        return originalFetch(input, init)
      }

      providerRequests.push(JSON.parse(String(init?.body ?? "{}")))
      return Response.json({
        id: "chatcmpl_cli_text_vision",
        choices: [{ message: { content: "cli mixed grounding answer" } }],
      })
    }) as typeof fetch
    const lines: string[] = []
    const home = await mkdtemp(join(tmpdir(), "owa-cli-home-"))
    const projectPath = resolve(import.meta.dir, "../../../..")

    try {
      await runCommand(
        {
          prompt: `Use mixed grounding on ${fixtureUrl}`,
          projectPath,
          agentId: "text-vision-mixed-grounding",
        },
        {
          env: {
            OWA_HOME: home,
            OPENAI_API_KEY: "test-openai-key",
            OPEN_WEB_AGENT_MODEL: "gpt-test",
            OPEN_WEB_AGENT_CODEX_AUTH_PATH: join(home, "missing-codex-auth.json"),
          },
          configPath: join(home, "missing-config.yaml"),
          stdout: (line) => lines.push(line),
        },
      )
    } finally {
      fixtureServer.stop(true)
      globalThis.fetch = originalFetch
    }

    expect(lines).toContain(`[browser.tool.completed] navigate ${fixtureUrl}`)
    expect(lines.at(-1)).toBe("[run.completed] cli mixed grounding answer")
    expect(JSON.stringify(providerRequests[0])).toContain("CLI fixture page text.")
  })
})

import { describe, expect, it } from "bun:test"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { runCommand } from "./run"

describe("runCommand", () => {
  it("prints the Example Domain final answer", async () => {
    const lines: string[] = []
    const home = await mkdtemp(join(tmpdir(), "owa-cli-home-"))

    await runCommand(
      {
        prompt: "example.com에 접속해서 페이지 제목을 알려줘",
        projectPath: "/tmp/open-web-agent-project",
      },
      {
        env: { OWA_HOME: home },
        stdout: (line) => lines.push(line),
      },
    )

    expect(lines).toContainEqual(expect.stringContaining("[run.started] run_"))
    expect(lines).toContain("[browser.tool.completed] navigate https://example.com")
    expect(lines.at(-1)).toBe('[run.completed] 페이지 제목은 "Example Domain"입니다.')
  })

  it("runs the project text-vision mixed grounding Python agent", async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (input, init) => {
      const url = String(input instanceof Request ? input.url : input)
      if (url.startsWith("http://127.0.0.1") || url.startsWith("http://localhost")) {
        return originalFetch(input, init)
      }

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
          prompt: "Use mixed grounding on example.com",
          projectPath,
          agentId: "text-vision-mixed-grounding",
        },
        {
          env: { OWA_HOME: home, OPENAI_API_KEY: "test-openai-key", OPEN_WEB_AGENT_MODEL: "gpt-test" },
          stdout: (line) => lines.push(line),
        },
      )
    } finally {
      globalThis.fetch = originalFetch
    }

    expect(lines).toContain("[browser.tool.completed] navigate https://example.com")
    expect(lines.at(-1)).toBe("[run.completed] cli mixed grounding answer")
  })
})

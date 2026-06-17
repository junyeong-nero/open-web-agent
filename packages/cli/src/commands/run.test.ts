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
    const lines: string[] = []
    const home = await mkdtemp(join(tmpdir(), "owa-cli-home-"))
    const projectPath = resolve(import.meta.dir, "../../../..")

    await runCommand(
      {
        prompt: "Use mixed grounding on example.com",
        projectPath,
        agentId: "text-vision-mixed-grounding",
      },
      {
        env: { OWA_HOME: home },
        stdout: (line) => lines.push(line),
      },
    )

    expect(lines).toContain("[browser.tool.completed] navigate https://example.com")
    expect(lines.at(-1)).toContain("[run.completed]")
    expect(lines.at(-1)).toContain("text grounding")
    expect(lines.at(-1)).toContain("vision grounding")
  })
})

import { describe, expect, it } from "bun:test"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

describe("CLI end-to-end smoke", () => {
  it("runs the headless Example Domain task", async () => {
    const home = await mkdtemp(join(tmpdir(), "owa-e2e-home-"))
    const proc = Bun.spawn(
      ["bun", "run", "packages/cli/src/index.ts", "run", "example.com에 접속해서 페이지 제목을 알려줘"],
      {
        cwd: join(import.meta.dir, "../../.."),
        env: { ...process.env, OWA_HOME: home },
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
    expect(stdout).toContain('[run.completed] 페이지 제목은 "Example Domain"입니다.')
    expect(stdout).toContain('페이지 제목은 "Example Domain"입니다.')
  })
})

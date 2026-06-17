import { describe, expect, it } from "bun:test"
import { mkdtemp, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { RuntimeContext } from "@open-web-agent/core"
import { EventBus } from "@open-web-agent/core"
import { MockBrowserToolAdapter, MockEnvironment, sleep } from "./mock-environment"

async function context(signal = new AbortController().signal, runId = "run_1", sessionId = "ses_1"): Promise<RuntimeContext> {
  return {
    session: {
      id: sessionId,
      projectPath: "/tmp/project",
      projectHash: "hash",
      createdAt: "2026-06-17T00:00:00.000Z",
    },
    runId,
    runDir: await mkdtemp(join(tmpdir(), "owa-mock-env-")),
    eventBus: new EventBus(),
    abortSignal: signal,
    now: () => new Date("2026-06-17T00:00:00.000Z"),
    async emit() {
      throw new Error("not used")
    },
  }
}

describe("MockEnvironment", () => {
  it("executes navigate, screenshot, and extract_text against the Example Domain fixture", async () => {
    const env = new MockEnvironment(0)
    const tools = new MockBrowserToolAdapter(env)
    const ctx = await context()

    await env.reset(ctx)
    const navigate = await tools.execute({ id: "tool_1", type: "navigate", url: "https://example.com" }, ctx)
    const screenshot = await tools.execute({ id: "tool_2", type: "screenshot" }, ctx)
    const text = await tools.execute({ id: "tool_3", type: "extract_text" }, ctx)

    expect(navigate.observation?.title).toBe("Example Domain")
    expect(screenshot.observation?.screenshotPath).toEndWith("screenshots/step-0001.txt")
    expect(await readFile(screenshot.observation?.screenshotPath ?? "", "utf8")).toBe(
      "mock screenshot for Example Domain\n",
    )
    expect(text.metadata).toEqual({
      text: "Example Domain\nThis domain is for use in illustrative examples in documents.",
    })
  })

  it("keeps observations isolated per session and retained across runs", async () => {
    const env = new MockEnvironment(0)
    const tools = new MockBrowserToolAdapter(env)
    const firstRun = await context(undefined, "run_1", "ses_1")
    const secondRunSameSession = await context(undefined, "run_2", "ses_1")
    const otherSession = await context(undefined, "run_3", "ses_2")

    await env.reset(firstRun)
    await tools.execute({ id: "tool_1", type: "navigate", url: "https://example.com" }, firstRun)
    await env.reset(secondRunSameSession)
    await env.reset(otherSession)

    expect((await env.observe(secondRunSameSession)).title).toBe("Example Domain")
    expect((await env.observe(otherSession)).url).toBe("about:blank")
  })

  it("rejects sleep when the abort signal is cancelled", async () => {
    const controller = new AbortController()
    const delayed = sleep(50, controller.signal)

    controller.abort()

    await expect(delayed).rejects.toThrow("Run cancelled")
  })
})

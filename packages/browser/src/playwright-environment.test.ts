import { describe, expect, it } from "bun:test"
import { mkdtemp, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { EventBus, type RuntimeContext } from "@open-web-agent/core"
import * as playwrightEnvironment from "./playwright-environment"
import { PlaywrightBrowserToolAdapter, PlaywrightEnvironment } from "./playwright-environment"

async function context(): Promise<RuntimeContext> {
  return {
    session: {
      id: "ses_1",
      projectPath: "/tmp/project",
      projectHash: "hash",
      createdAt: "2026-06-17T00:00:00.000Z",
    },
    runId: "run_1",
    runDir: await mkdtemp(join(tmpdir(), "owa-playwright-env-")),
    eventBus: new EventBus(),
    abortSignal: new AbortController().signal,
    now: () => new Date("2026-06-17T00:00:00.000Z"),
    async emit() {
      throw new Error("not used")
    },
  }
}

function fixtureUrl(): string {
  const html = `<!doctype html>
    <html>
      <head><title>Playwright Fixture</title></head>
      <body>
        <button id="toggle">Reveal</button>
        <input id="name" aria-label="Name" />
        <input id="hidden-token" type="hidden" name="where" value="nexearch" />
        <button id="hidden-button" style="display: none">Hidden</button>
        <main id="status">Idle</main>
        <script>
          document.querySelector("#toggle").addEventListener("click", () => {
            document.querySelector("#status").textContent = "Revealed"
          })
          document.querySelector("#name").addEventListener("input", (event) => {
            document.querySelector("#status").textContent = "Typed " + event.target.value
          })
        </script>
      </body>
    </html>`
  return `data:text/html,${encodeURIComponent(html)}`
}

describe("PlaywrightEnvironment", () => {
  it("uses headed browser launches by default", () => {
    expect("resolvePlaywrightHeadless" in playwrightEnvironment).toBe(true)
    expect(
      (playwrightEnvironment as typeof playwrightEnvironment & {
        resolvePlaywrightHeadless(options: { headless?: boolean }): boolean
      }).resolvePlaywrightHeadless({}),
    ).toBe(false)
  })

  it("adds the Chromium minimized startup flag when browser focus prevention is enabled", () => {
    expect("resolveChromiumLaunchOptions" in playwrightEnvironment).toBe(true)
    const resolveChromiumLaunchOptions = (
      playwrightEnvironment as typeof playwrightEnvironment & {
        resolveChromiumLaunchOptions(options: { headless?: boolean; preventFocus?: boolean }): {
          headless: boolean
          args?: string[]
        }
      }
    ).resolveChromiumLaunchOptions

    expect(resolveChromiumLaunchOptions({ preventFocus: true })).toEqual({
      headless: false,
      args: ["--start-minimized"],
    })
    expect(resolveChromiumLaunchOptions({ headless: true, preventFocus: true })).toEqual({ headless: true })
  })

  it("does not bring an existing page to the front when browser focus prevention is enabled", async () => {
    const env = new PlaywrightEnvironment({ preventFocus: true })
    const ctx = await context()
    let bringToFrontCalls = 0
    ;(env as unknown as { runs: Map<string, unknown> }).runs.set(ctx.session.id, {
      browser: {},
      context: {},
      page: {
        async bringToFront() {
          bringToFrontCalls += 1
        },
      },
      lastScreenshotPath: null,
      screenshotCount: 0,
    })

    await env.attachSession(ctx)

    expect(bringToFrontCalls).toBe(0)
  })

  it("navigates, interacts with a fixture page, observes text, and captures a screenshot", async () => {
    const env = new PlaywrightEnvironment({ headless: true })
    const tools = new PlaywrightBrowserToolAdapter(env)
    const ctx = await context()

    try {
      await env.reset(ctx)
      await tools.execute({ id: "tool_1", type: "navigate", url: fixtureUrl() }, ctx)
      await tools.execute(
        {
          id: "tool_2",
          type: "click",
          target: { selector: "#toggle", elementId: null, text: null, role: null, name: null, coordinates: null },
        },
        ctx,
      )
      await tools.execute(
        {
          id: "tool_3",
          type: "type",
          target: { selector: "#name", elementId: null, text: null, role: null, name: null, coordinates: null },
          value: "Ada",
        },
        ctx,
      )
      await tools.execute({ id: "tool_4", type: "wait", ms: 1 }, ctx)
      const screenshot = await tools.execute({ id: "tool_5", type: "screenshot" }, ctx)
      const text = await tools.execute({ id: "tool_6", type: "extract_text" }, ctx)
      const observation = await env.observe(ctx)

      expect(observation.title).toBe("Playwright Fixture")
      expect(observation.text).toContain("Typed Ada")
      expect(observation.interactiveElements.some((element) => element.selector === "#toggle")).toBe(true)
      expect(observation.interactiveElements.some((element) => element.selector === "#name")).toBe(true)
      expect(observation.interactiveElements.some((element) => element.selector === "#hidden-token")).toBe(false)
      expect(observation.interactiveElements.some((element) => element.selector === "#hidden-button")).toBe(false)
      expect(text.metadata.text).toContain("Typed Ada")
      expect(screenshot.observation?.screenshotPath).toEndWith(".png")
      expect((await stat(screenshot.observation?.screenshotPath ?? "")).isFile()).toBe(true)
    } finally {
      await env.close(ctx)
    }
  })
})

import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { ActionResult, BrowserEnvironment, BrowserToolCall, Observation, RuntimeContext } from "@open-web-agent/core"

const BLANK_OBSERVATION: Observation = {
  url: "about:blank",
  title: null,
  text: null,
  screenshotPath: null,
  interactiveElements: [],
  metadata: {},
}

const EXAMPLE_OBSERVATION: Observation = {
  url: "https://example.com/",
  title: "Example Domain",
  text: "Example Domain\nThis domain is for use in illustrative examples in documents.",
  screenshotPath: null,
  interactiveElements: [],
  metadata: {},
}

export class MockEnvironment implements BrowserEnvironment {
  id = "mock-browser"
  name = "Mock Browser"
  private observation: Observation = { ...BLANK_OBSERVATION }

  constructor(private readonly delayMs = 25) {}

  async reset(_ctx: RuntimeContext): Promise<void> {
    this.observation = { ...BLANK_OBSERVATION }
  }

  async observe(_ctx: RuntimeContext): Promise<Observation> {
    return this.observation
  }

  async execute(call: BrowserToolCall, ctx: RuntimeContext): Promise<ActionResult> {
    await sleep(this.delayMs, ctx.abortSignal)

    if (call.type === "navigate") {
      this.observation = { ...EXAMPLE_OBSERVATION }
      return { ok: true, message: "navigated", observation: this.observation, metadata: { url: call.url } }
    }

    if (call.type === "screenshot") {
      const screenshotPath = join(ctx.runDir, "screenshots", "step-0001.txt")
      await mkdir(join(ctx.runDir, "screenshots"), { recursive: true })
      await writeFile(screenshotPath, "mock screenshot for Example Domain\n")
      this.observation = { ...this.observation, screenshotPath }
      return { ok: true, message: "screenshot captured", observation: this.observation, metadata: { screenshotPath } }
    }

    if (call.type === "extract_text") {
      return { ok: true, message: "text extracted", observation: this.observation, metadata: { text: this.observation.text } }
    }

    return { ok: false, message: `Unsupported mock tool: ${call.type}`, observation: this.observation, metadata: {} }
  }

  async close(_ctx: RuntimeContext): Promise<void> {}
}

export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new DOMException("Run cancelled", "AbortError"))

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(resolve, ms)
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timeout)
        reject(new DOMException("Run cancelled", "AbortError"))
      },
      { once: true },
    )
  })
}

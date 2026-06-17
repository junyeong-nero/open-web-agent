import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type {
  ActionResult,
  BrowserEnvironment,
  BrowserToolCall,
  Observation,
  RuntimeContext,
  ToolAdapter,
} from "@open-web-agent/core"

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

  constructor(readonly delayMs = 25) {}

  async reset(_ctx: RuntimeContext): Promise<void> {
    this.observation = { ...BLANK_OBSERVATION }
  }

  async observe(_ctx: RuntimeContext): Promise<Observation> {
    return this.observation
  }

  currentObservation(): Observation {
    return this.observation
  }

  updateObservation(observation: Observation): void {
    this.observation = observation
  }

  async close(_ctx: RuntimeContext): Promise<void> {}
}

export class MockBrowserToolAdapter implements ToolAdapter {
  id = "mock-browser-tools"
  name = "Mock Browser Tools"
  environmentId = "mock-browser"

  constructor(private readonly environment: MockEnvironment) {}

  async execute(call: BrowserToolCall, ctx: RuntimeContext): Promise<ActionResult> {
    await sleep(this.environment.delayMs, ctx.abortSignal)

    if (call.type === "navigate") {
      const observation = { ...EXAMPLE_OBSERVATION }
      this.environment.updateObservation(observation)
      return { ok: true, message: "navigated", observation, metadata: { url: call.url } }
    }

    if (call.type === "screenshot") {
      const screenshotPath = join(ctx.runDir, "screenshots", "step-0001.txt")
      await mkdir(join(ctx.runDir, "screenshots"), { recursive: true })
      await writeFile(screenshotPath, "mock screenshot for Example Domain\n")
      const observation = { ...this.environment.currentObservation(), screenshotPath }
      this.environment.updateObservation(observation)
      return { ok: true, message: "screenshot captured", observation, metadata: { screenshotPath } }
    }

    if (call.type === "extract_text") {
      const observation = this.environment.currentObservation()
      return { ok: true, message: "text extracted", observation, metadata: { text: observation.text } }
    }

    return {
      ok: false,
      message: `Unsupported mock tool: ${call.type}`,
      observation: this.environment.currentObservation(),
      metadata: {},
    }
  }
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

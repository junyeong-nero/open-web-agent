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
  private observations = new Map<string, Observation>()

  constructor(readonly delayMs = 25) {}

  async reset(ctx: RuntimeContext): Promise<void> {
    this.observations.set(ctx.runId, { ...BLANK_OBSERVATION })
  }

  async observe(ctx: RuntimeContext): Promise<Observation> {
    return this.currentObservation(ctx)
  }

  currentObservation(ctx: RuntimeContext): Observation {
    return this.observations.get(ctx.runId) ?? { ...BLANK_OBSERVATION }
  }

  updateObservation(ctx: RuntimeContext, observation: Observation): void {
    this.observations.set(ctx.runId, observation)
  }

  async close(ctx: RuntimeContext): Promise<void> {
    this.observations.delete(ctx.runId)
  }
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
      this.environment.updateObservation(ctx, observation)
      return { ok: true, message: "navigated", observation, metadata: { url: call.url } }
    }

    if (call.type === "screenshot") {
      const screenshotPath = join(ctx.runDir, "screenshots", "step-0001.txt")
      await mkdir(join(ctx.runDir, "screenshots"), { recursive: true })
      await writeFile(screenshotPath, "mock screenshot for Example Domain\n")
      const observation = { ...this.environment.currentObservation(ctx), screenshotPath }
      this.environment.updateObservation(ctx, observation)
      return { ok: true, message: "screenshot captured", observation, metadata: { screenshotPath } }
    }

    if (call.type === "extract_text") {
      const observation = this.environment.currentObservation(ctx)
      return { ok: true, message: "text extracted", observation, metadata: { text: observation.text } }
    }

    return {
      ok: false,
      message: `Unsupported mock tool: ${call.type}`,
      observation: this.environment.currentObservation(ctx),
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

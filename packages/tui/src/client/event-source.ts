import { RunEventSchema, type RunEvent } from "@open-web-agent/core"

export interface EventStreamHandle {
  close(): void
}

export function createEventStream(baseUrl: string, onEvent: (event: RunEvent) => void): EventStreamHandle {
  const controller = new AbortController()

  void (async () => {
    const response = await fetch(`${baseUrl}/events`, { signal: controller.signal })
    if (!response.body) throw new Error("SSE response body is empty")

    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader()
    let buffer = ""

    while (!controller.signal.aborted) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += value

      const chunks = buffer.split("\n\n")
      buffer = chunks.pop() ?? ""

      for (const chunk of chunks) {
        const dataLine = chunk.split("\n").find((line) => line.startsWith("data: "))
        if (dataLine) onEvent(RunEventSchema.parse(JSON.parse(dataLine.slice("data: ".length))))
      }
    }
  })().catch((error) => {
    if (!controller.signal.aborted) console.error(error)
  })

  return { close: () => controller.abort() }
}

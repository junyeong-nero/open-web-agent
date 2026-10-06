import { expect, it } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { sumUsage } from "./agent"

it("sums the cache counts calls reported and keeps a cost only when every call reported one", () => {
  expect(sumUsage([])).toStrictEqual({ inputTokens: 0, outputTokens: 0 })
  const cached = { inputTokens: 11268, outputTokens: 26, cachedInputTokens: 11265, cost: 0.5 }
  expect(sumUsage([cached, { inputTokens: 100, outputTokens: 4, cachedInputTokens: 0, cacheWriteTokens: 90, cost: 0.25 }]))
    .toStrictEqual({ inputTokens: 11368, outputTokens: 30, cachedInputTokens: 11265, cacheWriteTokens: 90, cost: 0.75 })
  // Without one call's cost the sum would be an undercount, so it is left out; token counts still add up.
  expect(sumUsage([cached, { inputTokens: 100, outputTokens: 4 }])).toStrictEqual({ inputTokens: 11368, outputTokens: 30, cachedInputTokens: 11265 })
  expect(sumUsage([undefined, cached])).toStrictEqual({ inputTokens: 11268, outputTokens: 26, cachedInputTokens: 11265 })
})

it("prints summed usage with --json and records each call's model, duration and usage in the trace", async () => {
  const reply = (content: string, usage: Record<string, unknown>) => ({
    id: "gen-1791331200-a", provider: "Azure", model: "openai/gpt-6-luna", object: "chat.completion", created: 1791331200,
    choices: [{ index: 0, finish_reason: "stop", native_finish_reason: "stop", message: { role: "assistant", content } }],
    usage,
  })
  // The answer has no outcome line, so the agent makes a second, tool-less call for it.
  const replies = [
    reply("done", { prompt_tokens: 11268, completion_tokens: 26, total_tokens: 11294, cost: 0.00012595, prompt_tokens_details: { cached_tokens: 11265 } }),
    reply('{"outcome":"succeeded","unfinished":[]}', { prompt_tokens: 11300, completion_tokens: 12, total_tokens: 11312, cost: 0.00012224, prompt_tokens_details: { cached_tokens: 11264 } }),
  ]
  const endpoint = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch() {
      await Bun.sleep(50)
      return Response.json(replies.shift())
    },
  })
  const dir = mkdtempSync(join(tmpdir(), "owa-usage-"))
  const trace = join(dir, "trace.jsonl")
  try {
    const proc = Bun.spawn([
      process.execPath, join(import.meta.dir, "cli.ts"), "run", "Reply done", "--model", "typesafe/jev-router", "--api", "openai",
      "--base-url", `http://127.0.0.1:${endpoint.port}`, "--json", "--trace", trace,
    ], { env: { PATH: process.env.PATH }, stdout: "pipe", stderr: "pipe" })
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
    expect({ code, stderr }).toMatchObject({ code: 0 })

    const { usage } = JSON.parse(stdout)
    expect(usage).toMatchObject({ inputTokens: 22568, outputTokens: 38, cachedInputTokens: 22529 })
    expect(usage.cost).toBeCloseTo(0.00024819, 12)
    expect(usage).not.toHaveProperty("cacheWriteTokens")

    const calls = readFileSync(trace, "utf8").trim().split("\n").map((line) => JSON.parse(line)).filter((event) => event.type === "model")
    expect(calls.map((call) => call.usage)).toStrictEqual([
      { inputTokens: 11268, outputTokens: 26, cachedInputTokens: 11265, cost: 0.00012595 },
      { inputTokens: 11300, outputTokens: 12, cachedInputTokens: 11264, cost: 0.00012224 },
    ])
    for (const call of calls) {
      expect(call.model).toBe("openai/gpt-6-luna")
      expect(Number.isInteger(call.durationMs)).toBe(true)
      expect(call.durationMs).toBeGreaterThanOrEqual(45)
    }
  } finally {
    endpoint.stop(true)
    rmSync(dir, { recursive: true, force: true })
  }
})

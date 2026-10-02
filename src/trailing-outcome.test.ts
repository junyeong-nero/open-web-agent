import { expect, it } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runAgent, taskIncomplete } from "./agent"
import { BrowserSession } from "./browser"
import { createMcpServer } from "./mcp"
import { scriptedModel } from "./testing/scripted-model"

const examples = [
  { answer: "죄송하지만 현재 브라우저에서 실시간 시각을 확인할 수 없었어요. 답을 확인하지 못했습니다.", outcome: "blocked", unfinished: ["뉴욕의 현재 시각 확인"] },
  { answer: "… 구매 전에 다나와에서 최신 가격을 확인해 주세요.", outcome: "succeeded", unfinished: [] },
]

for (const { answer, outcome, unfinished } of examples) {
  const metadata = JSON.stringify({ outcome, unfinished })
  for (const suffix of [metadata, `\n${metadata}`, `\n\`\`\`json\n${metadata}\n\`\`\`\n`]) {
    it(`parses trailing ${outcome} metadata: ${suffix}`, async () => {
      const result = await runAgent({ task: "t", browser: new BrowserSession(), model: scriptedModel([
        () => ({ text: `${answer} ${suffix}`, toolCalls: [] }),
      ]) })
      expect(result).toMatchObject({ status: "completed", answer, outcome: { status: outcome, verification: "unverified", unfinished } })
      expect(taskIncomplete(result)).toBe(outcome === "blocked")
    })
  }
}

it.each([
  'Done',
  '{"answer":"Done","outcome":"succeeded"}',
  'Done {"outcome":"succeeded"}',
  'Done {"outcome":"unknown","unfinished":[]}',
  'Done {"outcome":"blocked","unfinished":[1]}',
  'Done {"answer":null,"outcome":"blocked","unfinished":[]}',
  'Done {"outcome":"blocked","unfinished":[]} More prose',
  'Done ```json\n{"outcome":"blocked","unfinished":[]}\n``` More prose',
  'Done {"outcome":"blocked","unfinished":[]',
  '{"outcome":"blocked","unfinished":[]}',
])("preserves unrecognized replies: %s", async text => {
  const result = await runAgent({ task: "t", browser: new BrowserSession(), model: scriptedModel([() => ({ text, toolCalls: [] })]) })
  expect(result.answer).toBe(text)
  expect(result.outcome.status).toBe("unknown")
})

it("uses an explicit answer with escaped quotes and braces in trailing JSON", async () => {
  const answer = 'A "quoted" {answer}'
  const text = `Prose with {braces}. ${JSON.stringify({ answer, outcome: "partial", unfinished: ["Check }"] })}`
  const result = await runAgent({ task: "t", browser: new BrowserSession(), model: scriptedModel([() => ({ text, toolCalls: [] })]) })
  expect(result).toMatchObject({ answer, outcome: { status: "partial", unfinished: ["Check }"] } })
})

it("still rejects an explicitly blank answer in trailing JSON", async () => {
  const text = 'Prose {"answer":" ","outcome":"blocked","unfinished":[]}'
  const result = await runAgent({ task: "t", browser: new BrowserSession(), model: scriptedModel([() => ({ text, toolCalls: [] })]) })
  expect(result).toMatchObject({ status: "failed", stopReason: "model_error" })
  expect(result.error).toContain("no answer or tool calls")
})

it("propagates trailing blocked metadata to MCP and the CLI exit code", async () => {
  const { answer, outcome, unfinished } = examples[0]!
  const text = `${answer} ${JSON.stringify({ outcome, unfinished })}`
  const session = new BrowserSession()
  const server = createMcpServer({ session, tools: [], agentModel: scriptedModel([() => ({ text, toolCalls: [] })]) })
  const response = await server.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "browser_task", arguments: { task: "t" } } })
  expect(response?.result).toMatchObject({ isError: true, structuredContent: { answer, outcome: { status: "blocked", unfinished } } })
  await session.close()

  const directory = await mkdtemp(join(tmpdir(), "owa-trailing-"))
  try {
    const module = join(directory, "model.ts")
    await Bun.write(module, `import { scriptedModel } from ${JSON.stringify(join(import.meta.dir, "testing/scripted-model.ts"))}\nexport default () => scriptedModel([() => ({ text: ${JSON.stringify(text)}, toolCalls: [] })])\n`)
    const proc = Bun.spawn([process.execPath, join(import.meta.dir, "cli.ts"), "run", "t", "--headless", "--json", "--model-module", module], { stdout: "pipe", stderr: "pipe" })
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
    expect(stderr).toContain("completed in 1 steps")
    expect(code).toBe(1)
    expect(JSON.parse(stdout)).toMatchObject({ answer, outcome: { status: "blocked", unfinished } })
  } finally { await rm(directory, { recursive: true, force: true }) }
})

it("preserves pure structured answers", async () => {
  const text = '{"answer":"Done","outcome":"succeeded","unfinished":[]}'
  const result = await runAgent({ task: "t", browser: new BrowserSession(), model: scriptedModel([() => ({ text, toolCalls: [] })]) })
  expect(result).toMatchObject({ status: "completed", answer: "Done", outcome: { status: "succeeded", unfinished: [] } })
})

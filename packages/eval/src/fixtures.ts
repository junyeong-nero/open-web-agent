import type { ReplayActionLog, ReplayCombination } from "./replay-log"

export interface MockWebsiteFixture {
  id: string
  url: string
  title: string
  text: string
  html: string
}

export interface BenchmarkTaskFixture {
  id: string
  fixtureId: string
  prompt: string
  expectedAnswerIncludes: string
}

export const MOCK_WEBSITE_FIXTURES: MockWebsiteFixture[] = [
  {
    id: "example-domain",
    url: "https://example.com/",
    title: "Example Domain",
    text: "Example Domain\nThis domain is for use in illustrative examples in documents.",
    html: [
      "<!doctype html>",
      '<html lang="en">',
      "<head><title>Example Domain</title></head>",
      "<body>",
      "<h1>Example Domain</h1>",
      "<p>This domain is for use in illustrative examples in documents.</p>",
      "</body>",
      "</html>",
    ].join("\n"),
  },
]

export const BENCHMARK_TASKS: BenchmarkTaskFixture[] = [
  {
    id: "example-domain-title",
    fixtureId: "example-domain",
    prompt: "example.com에 접속해서 페이지 제목을 알려줘",
    expectedAnswerIncludes: "Example Domain",
  },
]

export const DEFAULT_EVALUATION_COMBINATIONS: ReplayCombination[] = [
  { agentId: "mock-agent", modelId: "none", environmentId: "mock-browser" },
]

export function getBenchmarkTask(taskId: string): BenchmarkTaskFixture {
  const task = BENCHMARK_TASKS.find((candidate) => candidate.id === taskId)
  if (!task) throw new Error(`Unknown benchmark task: ${taskId}`)
  return task
}

export function getMockWebsiteFixture(fixtureId: string): MockWebsiteFixture {
  const fixture = MOCK_WEBSITE_FIXTURES.find((candidate) => candidate.id === fixtureId)
  if (!fixture) throw new Error(`Unknown mock website fixture: ${fixtureId}`)
  return fixture
}

export function createFixtureReplayLog(task: BenchmarkTaskFixture, combo: ReplayCombination): ReplayActionLog {
  if (combo.agentId === "broken-agent") {
    return {
      version: 1,
      taskId: task.id,
      combo,
      entries: [{ sequence: 0, type: "run.failed", message: "Fixture combination failed before answer" }],
    }
  }

  const fixture = getMockWebsiteFixture(task.fixtureId)

  return {
    version: 1,
    taskId: task.id,
    combo,
    entries: [
      {
        sequence: 0,
        type: "browser.tool",
        toolCall: { id: "tool_1", type: "navigate", url: fixture.url },
        result: {
          ok: true,
          message: "navigated",
          observation: { url: fixture.url, title: fixture.title, text: fixture.text },
          metadata: { latencyMs: 12 },
        },
        latencyMs: 12,
      },
      {
        sequence: 1,
        type: "browser.tool",
        toolCall: { id: "tool_2", type: "screenshot" },
        result: {
          ok: true,
          message: "screenshot captured",
          observation: { url: fixture.url, title: fixture.title, text: fixture.text },
          metadata: { latencyMs: 8 },
        },
        latencyMs: 8,
      },
      {
        sequence: 2,
        type: "browser.tool",
        toolCall: { id: "tool_3", type: "extract_text" },
        result: {
          ok: true,
          message: "text extracted",
          observation: { url: fixture.url, title: fixture.title, text: fixture.text },
          metadata: { latencyMs: 18 },
        },
        latencyMs: 18,
      },
      {
        sequence: 3,
        type: "model",
        latencyMs: 25,
        inputTokens: 3,
        outputTokens: 2,
        totalTokens: 5,
        costUsd: 0.001,
      },
      {
        sequence: 4,
        type: "run.completed",
        finalAnswer: `페이지 제목은 "${fixture.title}"입니다.`,
      },
    ],
  }
}

import { describe, expect, it } from "bun:test"
import { BENCHMARK_TASKS, MOCK_WEBSITE_FIXTURES } from "./fixtures"
import { formatComparisonSummary, runFixtureComparison } from "./comparison"

describe("runFixtureComparison", () => {
  it("summarizes benchmark fixture results across combinations", () => {
    const comparison = runFixtureComparison({
      taskIds: ["example-domain-title"],
      combinations: [
        { agentId: "simple-react-agent", modelId: "openrouter", environmentId: "playwright-browser" },
        { agentId: "broken-agent", modelId: "openrouter", environmentId: "playwright-browser" },
      ],
    })

    expect(MOCK_WEBSITE_FIXTURES).toContainEqual(expect.objectContaining({ id: "example-domain" }))
    expect(BENCHMARK_TASKS).toContainEqual(expect.objectContaining({ id: "example-domain-title" }))
    expect(comparison.summary).toEqual({
      totalRuns: 2,
      successes: 1,
      failures: 1,
      totalLatencyMs: 63,
      totalCostUsd: 0.001,
    })
    expect(comparison.results.map((result) => [result.combo.agentId, result.status])).toEqual([
      ["simple-react-agent", "success"],
      ["broken-agent", "failure"],
    ])
  })

  it("formats a compact success/failure latency/cost report", () => {
    const report = formatComparisonSummary(
      runFixtureComparison({
        taskIds: ["example-domain-title"],
        combinations: [{ agentId: "simple-react-agent", modelId: "openrouter", environmentId: "playwright-browser" }],
      }),
    )

    expect(report).toContain("runs: 1")
    expect(report).toContain("success: 1")
    expect(report).toContain("latency_ms: 63")
    expect(report).toContain("cost_usd: 0.001")
    expect(report).toContain("example-domain-title simple-react-agent/openrouter/playwright-browser success")
  })
})

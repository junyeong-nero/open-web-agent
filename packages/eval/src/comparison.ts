import {
  BENCHMARK_TASKS,
  DEFAULT_EVALUATION_COMBINATIONS,
  createFixtureReplayLog,
  getBenchmarkTask,
  type BenchmarkTaskFixture,
} from "./fixtures"
import type { ReplayActionLog, ReplayCombination } from "./replay-log"

export interface EvaluationResult {
  taskId: string
  combo: ReplayCombination
  status: "success" | "failure"
  finalAnswer: string | null
  latencyMs: number
  costUsd: number
  log: ReplayActionLog
}

export interface EvaluationSummary {
  totalRuns: number
  successes: number
  failures: number
  totalLatencyMs: number
  totalCostUsd: number
}

export interface EvaluationComparison {
  results: EvaluationResult[]
  summary: EvaluationSummary
}

export interface RunFixtureComparisonInput {
  taskIds?: string[]
  combinations?: ReplayCombination[]
}

export function runFixtureComparison(input: RunFixtureComparisonInput = {}): EvaluationComparison {
  const taskIds = input.taskIds && input.taskIds.length > 0 ? input.taskIds : BENCHMARK_TASKS.map((task) => task.id)
  const combinations =
    input.combinations && input.combinations.length > 0 ? input.combinations : DEFAULT_EVALUATION_COMBINATIONS
  const results = taskIds.flatMap((taskId) => {
    const task = getBenchmarkTask(taskId)
    return combinations.map((combo) => evaluateReplayLog(createFixtureReplayLog(task, combo), task))
  })

  return { results, summary: summarizeResults(results) }
}

export function evaluateReplayLog(log: ReplayActionLog, task: BenchmarkTaskFixture): EvaluationResult {
  const failed = log.entries.find((entry) => entry.type === "run.failed")
  const completed = log.entries.find((entry) => entry.type === "run.completed")
  const finalAnswer = completed?.finalAnswer ?? null
  const status = !failed && finalAnswer?.includes(task.expectedAnswerIncludes) ? "success" : "failure"

  return {
    taskId: log.taskId,
    combo: log.combo,
    status,
    finalAnswer,
    latencyMs: log.entries.reduce((sum, entry) => sum + ("latencyMs" in entry ? entry.latencyMs : 0), 0),
    costUsd: log.entries.reduce((sum, entry) => sum + (entry.type === "model" ? entry.costUsd : 0), 0),
    log,
  }
}

export function summarizeResults(results: EvaluationResult[]): EvaluationSummary {
  return {
    totalRuns: results.length,
    successes: results.filter((result) => result.status === "success").length,
    failures: results.filter((result) => result.status === "failure").length,
    totalLatencyMs: results.reduce((sum, result) => sum + result.latencyMs, 0),
    totalCostUsd: roundCost(results.reduce((sum, result) => sum + result.costUsd, 0)),
  }
}

export function formatComparisonSummary(comparison: EvaluationComparison): string {
  return [
    `runs: ${comparison.summary.totalRuns}`,
    `success: ${comparison.summary.successes}`,
    `failure: ${comparison.summary.failures}`,
    `latency_ms: ${comparison.summary.totalLatencyMs}`,
    `cost_usd: ${formatCost(comparison.summary.totalCostUsd)}`,
    "",
    "results:",
    ...comparison.results.map(
      (result) =>
        `${result.taskId} ${formatCombination(result.combo)} ${result.status} latency_ms=${result.latencyMs} cost_usd=${formatCost(result.costUsd)}`,
    ),
  ].join("\n")
}

export function formatCombination(combo: ReplayCombination): string {
  return `${combo.agentId}/${combo.modelId}/${combo.environmentId}`
}

function roundCost(value: number): number {
  return Number(value.toFixed(6))
}

function formatCost(value: number): string {
  return roundCost(value).toString()
}

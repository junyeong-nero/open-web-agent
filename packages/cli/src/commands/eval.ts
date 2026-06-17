import { formatComparisonSummary, runFixtureComparison, type ReplayCombination } from "@open-web-agent/eval"

export interface EvalCommandInput {
  taskIds?: string[]
  combinations?: ReplayCombination[]
}

export interface EvalCommandOptions {
  stdout?: (line: string) => void
}

export function evalCommand(input: EvalCommandInput, options: EvalCommandOptions = {}): void {
  const stdout = options.stdout ?? ((line: string) => console.log(line))
  const comparison = runFixtureComparison({ taskIds: input.taskIds, combinations: input.combinations })

  for (const line of formatComparisonSummary(comparison).split("\n")) {
    stdout(line)
  }
}

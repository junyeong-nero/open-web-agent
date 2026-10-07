import { sumUsage } from "../agent"
import { parseModelOptions } from "../model/resolve"
import type { Usage } from "../model/types"

/** A benchmark task. `task` goes to `owa run` unchanged; other fields, such as a dataset's metadata, are ignored. */
export interface BenchTask {
  id: string
  task: string
}

/** One configuration to compare. */
export interface BenchArm {
  name: string
  /** `--model`, e.g. openai:gpt-6-luna */
  model: string
  /** `--model-options` */
  modelOptions?: Record<string, unknown>
  /** More `owa run` flags, e.g. ["--max-steps", "30"] */
  flags?: string[]
  /** USD per million tokens, for a cost estimate when the provider reports no cost. */
  prices?: { input: number; cachedInput?: number; output: number }
}

/** How one `owa run` process ended, stored next to its result, trace and stderr. */
export interface RunMeta {
  arm: string
  task: string
  run: number
  args: string[]
  exitCode: number | null
  signal: string | null
  /** The runner stopped the process after the per-run timeout. */
  timedOut: boolean
  seconds: number
  startedAt: string
}

const TOOL_ERROR_CLASSES = ["stale_ref", "click_intercepted", "not_visible", "navigation", "download", "invalid_arguments", "other"] as const
export type ToolErrorClass = (typeof TOOL_ERROR_CLASSES)[number]

const TOOL_ERROR_LABELS: Record<ToolErrorClass, string> = {
  stale_ref: "stale ref",
  click_intercepted: "click intercepted",
  not_visible: "not visible or outside the viewport",
  navigation: "navigation failure",
  download: "download",
  invalid_arguments: "invalid arguments",
  other: "other",
}

export interface RunRecord {
  arm: string
  task: string
  run: number
  /** The agent's stopReason, `run_timeout` when the runner stopped the run, or `cli_error` when the CLI gave no result. */
  stopReason: string
  /** The model's own, unverified outcome.status, or `none` without a result. */
  outcome: string
  steps: number
  modelCalls: number
  /** Wall-clock time of the model calls. */
  modelMs: number
  /** Model calls by the model each response named; a router names the model it chose. */
  servedBy: Record<string, number>
  usage: Usage
  seconds: number
  toolCalls: number
  toolErrors: Partial<Record<ToolErrorClass, number>>
  answer?: string
  error?: string
}

export interface Summary {
  runs: number
  outcomes: Record<string, number>
  stopReasons: Record<string, number>
  steps: { median: number; total: number }
  modelCalls: number
  modelMs: number
  servedBy: Record<string, number>
  /** Summed like a run's usage: a cost appears only when every run that called the model reported one. */
  usage: Usage
  /** In USD from the arm's prices. Cache reads are billed at the cached price, everything else at the input price. */
  estimatedCost?: number
  seconds: { median: number; total: number }
  toolCalls: number
  toolErrors: Record<ToolErrorClass, number>
}

export interface BenchReport {
  /** Planned runs per task and arm. */
  runs: number
  arms: BenchArm[]
  tasks: string[]
  overall: Record<string, Summary>
  perTask: Record<string, Record<string, Summary>>
  records: RunRecord[]
}

/** Display order; values from newer results follow. */
const OUTCOMES = ["succeeded", "partial", "blocked", "unknown", "none"]
const STOP_REASONS = ["final_answer", "step_limit", "no_progress", "tool_failures", "model_error", "timeout", "cancelled", "run_timeout", "cli_error"]

/** Flags the runner sets itself. */
const RUNNER_FLAGS = ["--json", "--headless", "--trace", "--model", "--model-options"]

/** Runs are stored in <out>/runs/<arm>/<task id>/<run>/, so ids must be usable as directory names. */
const DIRECTORY_NAME = /^(?!\.\.?$)[^/\\\u0000-\u001f]+$/

export function parseTasks(value: unknown): BenchTask[] {
  if (!Array.isArray(value) || !value.length) throw new Error("The task file must be a non-empty JSON array of { id, task }")
  const ids = new Set<string>()
  return value.map((entry: unknown, index) => {
    const { id, task }: Record<string, unknown> = isRecord(entry) ? entry : {}
    if (typeof id !== "string" || !DIRECTORY_NAME.test(id)) throw new Error(`Task ${index + 1}: "id" must be a string usable as a directory name`)
    if (ids.has(id)) throw new Error(`Duplicate task id "${id}"`)
    if (typeof task !== "string" || !task.trim()) throw new Error(`Task "${id}": "task" must be a non-empty string`)
    ids.add(id)
    return { id, task }
  })
}

export function parseArms(value: unknown): BenchArm[] {
  if (!Array.isArray(value) || !value.length) throw new Error("The arms file must be a non-empty JSON array of { name, model }")
  const names = new Set<string>()
  return value.map((entry: unknown, index) => {
    const fields: Record<string, unknown> = isRecord(entry) ? entry : {}
    const { name, model, modelOptions, flags, prices } = fields
    if (typeof name !== "string" || !/^[\w.-]+$/.test(name) || !DIRECTORY_NAME.test(name)) {
      throw new Error(`Arm ${index + 1}: "name" must contain only letters, digits, ".", "_" and "-"`)
    }
    if (names.has(name)) throw new Error(`Duplicate arm name "${name}"`)
    names.add(name)
    // A misspelled field would silently drop an option from the comparison.
    const unknown = Object.keys(fields).find((key) => !["name", "model", "modelOptions", "flags", "prices"].includes(key))
    if (unknown) throw new Error(`Arm "${name}": unknown field "${unknown}"`)
    if (typeof model !== "string" || !model) throw new Error(`Arm "${name}": "model" must be a provider:model string`)
    if (modelOptions !== undefined) {
      try {
        parseModelOptions(JSON.stringify(modelOptions))
      } catch (error) {
        throw new Error(`Arm "${name}": ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    if (flags !== undefined && !isStrings(flags)) throw new Error(`Arm "${name}": "flags" must be an array of strings`)
    const managed = flags?.find((flag) => RUNNER_FLAGS.includes(flag.split("=")[0]))
    if (managed) throw new Error(`Arm "${name}": the runner sets ${managed.split("=")[0]}; use the arm's model and modelOptions fields`)
    const price = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0
    if (prices !== undefined && !(isRecord(prices) && price(prices.input) && price(prices.output)
      && (prices.cachedInput === undefined || price(prices.cachedInput))
      && Object.keys(prices).every((key) => ["input", "cachedInput", "output"].includes(key)))) {
      throw new Error(`Arm "${name}": "prices" must be { input, cachedInput?, output } in USD per million tokens`)
    }
    return {
      name,
      model,
      ...(modelOptions === undefined ? {} : { modelOptions: modelOptions as Record<string, unknown> }),
      ...(flags === undefined ? {} : { flags }),
      ...(prices === undefined ? {} : { prices: prices as BenchArm["prices"] }),
    }
  })
}

/** Every run, task by task with the arms side by side: arms see each site at about the same time and stay balanced when stopped early. */
export function planRuns(tasks: BenchTask[], arms: BenchArm[], runs: number): Array<{ arm: BenchArm; task: BenchTask; run: number }> {
  const plan = []
  for (let run = 1; run <= runs; run++) for (const task of tasks) for (const arm of arms) plan.push({ arm, task, run })
  return plan
}

/** Group a failed tool result by its message, as `callTool` and Playwright word it. */
export function toolErrorClass(text: string): ToolErrorClass {
  if (/^(?:Invalid arguments for |Unknown tool ")|is not a snapshot ref|^No text at offset=/.test(text)) return "invalid_arguments"
  if (/The server sent a file|Download is starting/.test(text)) return "download"
  if (/\b(?:goto|goBack): /.test(text)) return "navigation"
  if (/intercepts pointer events/.test(text)) return "click_intercepted"
  if (/element is not visible|element is outside of the viewport/i.test(text)) return "not_visible"
  if (/is (?:not|no longer) on the page, so nothing was done|Unknown or closed tab|detached from the DOM|not attached to the DOM/i.test(text)) return "stale_ref"
  return "other"
}

/** Read one run from its files: the `--json` result on stdout, the JSONL trace and stderr. */
export function runRecord(meta: RunMeta, files: { stdout?: string; trace?: string; stderr?: string }): RunRecord {
  const events = parseTrace(files.trace ?? "")
  // A run stopped while closing the browser printed nothing, but its trace may already hold the result.
  const result = asResult(parseJson(files.stdout ?? "")) ?? events.map((event) => event.type === "done" ? asResult(event.result) : undefined).findLast(Boolean)
  // The runner stops a run with SIGINT, which the CLI reports as cancelled.
  const stopReason = meta.timedOut && (!result || result.stopReason === "cancelled") ? "run_timeout" : result?.stopReason ?? "cli_error"
  const models = events.filter((event) => event.type === "model")
  const tools = events.filter((event) => event.type === "tool")
  const servedBy = count(models.flatMap((event) => typeof event.model === "string" ? [event.model] : []))
  const toolErrors: RunRecord["toolErrors"] = {}
  for (const { result: toolResult } of tools) {
    if (!isRecord(toolResult) || !toolResult.isError) continue
    const kind = toolErrorClass(String(toolResult.text ?? ""))
    toolErrors[kind] = (toolErrors[kind] ?? 0) + 1
  }
  const error = result?.error ?? (stopReason === "cli_error" ? files.stderr?.trim().split("\n").at(-1) : undefined)
  return {
    arm: meta.arm,
    task: meta.task,
    run: meta.run,
    stopReason,
    outcome: result ? result.outcome?.status ?? "unknown" : "none",
    steps: result?.steps ?? Math.max(0, ...events.map((event) => event.type === "step" && typeof event.step === "number" ? event.step : 0)),
    modelCalls: models.length,
    modelMs: sum(models.map((event) => typeof event.durationMs === "number" ? event.durationMs : 0)),
    servedBy,
    // Without a result, add up the calls in the trace the way the agent does.
    usage: asUsage(result?.usage) ?? sumUsage(models.map((event) => asUsage(event.usage))),
    seconds: meta.seconds,
    toolCalls: tools.length,
    toolErrors,
    ...(result?.answer === undefined ? {} : { answer: result.answer }),
    ...(error ? { error } : {}),
  }
}

export function summarize(records: RunRecord[], prices?: BenchArm["prices"]): Summary {
  const steps = records.map((record) => record.steps)
  const seconds = records.map((record) => record.seconds)
  // A run without model calls (a CLI error) has nothing to bill, so it must not hide the other runs' cost.
  const usage = sumUsage(records.filter((record) => record.modelCalls > 0).map((record) => record.usage))
  const servedBy: Record<string, number> = {}
  for (const record of records) for (const [model, calls] of Object.entries(record.servedBy)) servedBy[model] = (servedBy[model] ?? 0) + calls
  return {
    runs: records.length,
    outcomes: count(records.map((record) => record.outcome)),
    stopReasons: count(records.map((record) => record.stopReason)),
    steps: { median: median(steps), total: sum(steps) },
    modelCalls: sum(records.map((record) => record.modelCalls)),
    modelMs: sum(records.map((record) => record.modelMs)),
    servedBy,
    usage,
    ...(prices ? { estimatedCost: estimateCost(usage, prices) } : {}),
    seconds: { median: median(seconds), total: round(sum(seconds)) },
    toolCalls: sum(records.map((record) => record.toolCalls)),
    toolErrors: Object.fromEntries(TOOL_ERROR_CLASSES.map((kind) => [kind, sum(records.map((record) => record.toolErrors[kind] ?? 0))])) as Record<ToolErrorClass, number>,
  }
}

/** Summaries per arm, overall and per task. `records` must cover only the planned arms, tasks and runs. */
export function compare(arms: BenchArm[], tasks: BenchTask[], runs: number, records: RunRecord[]): BenchReport {
  const of = (arm: BenchArm, task?: BenchTask) => summarize(records.filter((record) => record.arm === arm.name && (!task || record.task === task.id)), arm.prices)
  return {
    runs,
    arms,
    tasks: tasks.map((task) => task.id),
    overall: Object.fromEntries(arms.map((arm) => [arm.name, of(arm)])),
    perTask: Object.fromEntries(tasks.map((task) => [task.id, Object.fromEntries(arms.map((arm) => [arm.name, of(arm, task)]))])),
    records,
  }
}

/** The arms and their overall results side by side, as Markdown. */
export function renderSummary({ arms, tasks, runs, overall }: BenchReport): string {
  const summaries = arms.map((arm) => overall[arm.name])
  const row = (label: string, cell: (summary: Summary) => string) => [label, ...summaries.map(cell)]
  const counts = (label: string, of: (summary: Summary) => Record<string, number>, known: string[]) =>
    ordered(summaries.flatMap((summary) => Object.keys(of(summary))), known).map((key) => row(`${label}: ${key}`, (summary) => number(of(summary)[key] ?? 0)))
  const rows = [
    row("finished runs", (summary) => `${summary.runs}/${tasks.length * runs}`),
    ...counts("outcome", (summary) => summary.outcomes, OUTCOMES),
    ...counts("stop", (summary) => summary.stopReasons, STOP_REASONS),
    row("steps (median / total)", (summary) => `${number(summary.steps.median)} / ${number(summary.steps.total)}`),
    row("wall time (median / total)", (summary) => `${duration(summary.seconds.median)} / ${duration(summary.seconds.total)}`),
    row("model calls", (summary) => number(summary.modelCalls)),
    row("model call time (mean / total)", (summary) => summary.modelCalls ? `${duration(summary.modelMs / summary.modelCalls / 1000)} / ${duration(summary.modelMs / 1000)}` : "n/a"),
    row("served by", (summary) => Object.entries(summary.servedBy).sort(([, a], [, b]) => b - a).map(([model, calls]) => `${model} (${number(calls)})`).join(", ") || "n/a"),
    row("input tokens", (summary) => optional(summary.usage.inputTokens, number)),
    row("cached input tokens", (summary) => optional(summary.usage.cachedInputTokens, number)),
    ...(summaries.some((summary) => summary.usage.cacheWriteTokens !== undefined) ? [row("cache write tokens", (summary) => optional(summary.usage.cacheWriteTokens, number))] : []),
    row("output tokens", (summary) => optional(summary.usage.outputTokens, number)),
    row("cost reported by the provider", (summary) => optional(summary.usage.cost, (cost) => cost.toFixed(4))),
    ...(arms.some((arm) => arm.prices) ? [row("cost estimated from prices", (summary) => optional(summary.estimatedCost, (cost) => `$${cost.toFixed(4)}`))] : []),
    row("tool calls", (summary) => number(summary.toolCalls)),
    ...TOOL_ERROR_CLASSES.map((kind) => row(`tool errors: ${TOOL_ERROR_LABELS[kind]}`, (summary) => number(summary.toolErrors[kind]))),
  ]
  return [
    "# Benchmark summary",
    "",
    `${tasks.length} task${tasks.length === 1 ? "" : "s"}, ${runs} run${runs === 1 ? "" : "s"} per task and arm.`,
    "",
    ...arms.map((arm) => `- **${arm.name}**: ${describeArm(arm)}`),
    "",
    "Outcomes are the model's own unverified assessment, and n/a means no run recorded the value.",
    "Reported cost is in the provider's unit (US dollars for OpenRouter) and appears only when every run that called the model reported one.",
    "Estimated cost uses the arm's prices.",
    "",
    "## Overall",
    "",
    table(["", ...arms.map((arm) => arm.name)], rows),
  ].join("\n")
}

/** One row per task with the arms side by side, as Markdown. */
export function renderPerTask({ arms, tasks, runs, perTask, records }: BenchReport): string {
  const cell = (arm: BenchArm, task: string) => {
    const summary = perTask[task][arm.name]
    if (!summary.runs) return "—"
    const results = records.filter((record) => record.arm === arm.name && record.task === task).sort((a, b) => a.run - b.run)
      .map((record) => record.outcome === "none" ? record.stopReason : record.stopReason === "final_answer" ? record.outcome : `${record.outcome} (${record.stopReason})`)
    const errors = TOOL_ERROR_CLASSES.reduce((total, kind) => total + summary.toolErrors[kind], 0)
    return [
      results.join(", "),
      `${number(summary.steps.median)} step${summary.steps.median === 1 ? "" : "s"}`,
      duration(summary.seconds.median),
      `${compact(summary.usage.inputTokens ?? 0)} in`,
      ...(errors ? [`${errors} tool error${errors === 1 ? "" : "s"}`] : []),
      ...(summary.runs < runs ? [`${summary.runs}/${runs} runs`] : []),
    ].join(" · ")
  }
  return [
    "## Per task",
    "",
    "Each cell: the outcome of each run (with the stop reason unless it is final_answer), median steps, median wall time, input tokens and tool errors.",
    "",
    table(["task", ...arms.map((arm) => arm.name)], tasks.map((task) => [task, ...arms.map((arm) => cell(arm, task))])),
  ].join("\n")
}

function median(values: number[]): number {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

interface ResultLike {
  stopReason: string
  outcome?: { status?: string }
  steps?: number
  usage?: unknown
  answer?: string
  error?: string
}

function asResult(value: unknown): ResultLike | undefined {
  return isRecord(value) && typeof value.stopReason === "string" ? (value as unknown as ResultLike) : undefined
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function parseTrace(text: string): Record<string, unknown>[] {
  // A run stopped mid-write can leave a partial last line.
  return text.split("\n").map(parseJson).filter(isRecord)
}

function asUsage(value: unknown): Usage | undefined {
  return isRecord(value) ? (value as Usage) : undefined
}

/** `inputTokens` includes cache reads and writes; writes are billed like other input here. */
function estimateCost(usage: Usage, prices: NonNullable<BenchArm["prices"]>): number {
  const input = usage.inputTokens ?? 0
  const cached = Math.min(usage.cachedInputTokens ?? 0, input)
  return ((input - cached) * prices.input + cached * (prices.cachedInput ?? prices.input) + (usage.outputTokens ?? 0) * prices.output) / 1e6
}

function describeArm(arm: BenchArm): string {
  return [
    `\`${arm.model}\``,
    ...(arm.modelOptions ? [`model options \`${JSON.stringify(arm.modelOptions)}\``] : []),
    ...(arm.flags?.length ? [`flags \`${arm.flags.join(" ")}\``] : []),
    ...(arm.prices ? [`prices per million tokens: input $${arm.prices.input}, cached input $${arm.prices.cachedInput ?? arm.prices.input}, output $${arm.prices.output}`] : []),
  ].join(", ")
}

/** Known values first, in order, then any others in the order they appear. */
function ordered(values: string[], known: string[]): string[] {
  const unique = [...new Set(values)]
  return [...known.filter((value) => unique.includes(value)), ...unique.filter((value) => !known.includes(value))]
}

function table(header: string[], rows: string[][]): string {
  const line = (cells: string[]) => `| ${cells.map((cell) => cell.replaceAll("|", "\\|")).join(" | ")} |`
  return [line(header), line(header.map(() => "---")), ...rows.map(line)].join("\n")
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0)
}

function count(values: string[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1
  return counts
}

function number(value: number): string {
  return value.toLocaleString("en-US", { maximumFractionDigits: 1 })
}

function duration(seconds: number): string {
  return seconds < 60 ? `${seconds.toFixed(1)} s` : `${(seconds / 60).toFixed(1)} min`
}

function compact(value: number): string {
  return value >= 1e6 ? `${(value / 1e6).toFixed(1)}M` : value >= 1e3 ? `${Math.round(value / 1e3)}k` : String(value)
}

function optional(value: number | undefined, format: (value: number) => string): string {
  return value === undefined ? "n/a" : format(value)
}

function round(value: number): number {
  return Math.round(value * 10) / 10
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isStrings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
}

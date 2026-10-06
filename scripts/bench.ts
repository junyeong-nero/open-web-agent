import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { parseArgs } from "node:util"
import type { Subprocess } from "bun"
import { type BenchArm, type BenchTask, compare, parseArms, parseTasks, planRuns, renderPerTask, renderSummary, type RunMeta, runRecord, type RunRecord } from "../src/testing/bench"

const USAGE = `bun run bench --tasks <tasks.json> --arms <arms.json> --out <dir> [--runs 1] [--parallel 1] [--run-timeout 600]

Runs every task with every arm through \`owa run\` on real websites and real model APIs, which costs money.
Rerun the same command to resume; finished runs are skipped. See docs/evaluation.md for the file formats.`

const CLI = join(import.meta.dir, "../src/cli.ts")

async function main(): Promise<number> {
  const { values } = parseArgs({ args: process.argv.slice(2), options: {
    tasks: { type: "string" }, arms: { type: "string" }, out: { type: "string" },
    runs: { type: "string", default: "1" }, parallel: { type: "string", default: "1" }, "run-timeout": { type: "string", default: "600" },
    help: { type: "boolean" },
  } })
  if (values.help || !values.tasks || !values.arms || !values.out) {
    console.log(USAGE)
    return values.help ? 0 : 1
  }
  const runs = positiveInteger(values.runs, "--runs")
  const parallel = positiveInteger(values.parallel, "--parallel")
  const timeoutSeconds = positiveInteger(values["run-timeout"], "--run-timeout")
  const tasks = parseTasks(readJson(values.tasks))
  const arms = parseArms(readJson(values.arms))
  const out = values.out
  for (const arm of arms) recordArm(out, arm)

  const plan = planRuns(tasks, arms, runs)
  // Runs without meta.json were interrupted; runs without a result failed outside the agent (e.g. a missing API key).
  const pending = plan.filter(({ arm, task, run }) => (load(out, arm, task, run)?.stopReason ?? "cli_error") === "cli_error")
  console.error(`${plan.length} runs planned, ${plan.length - pending.length} finished before; running ${pending.length}, ${parallel} at a time.`)

  // Only the arm's configuration applies, not OWA_MODEL or OWA_MODEL_OPTIONS from this shell.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("OWA_") || key === "OWA_API_KEY"))
  const running = new Set<Subprocess>()
  let interrupted = false
  const interrupt = () => {
    if (interrupted) process.exit(130)
    interrupted = true
    console.error("Stopping. Unfinished runs will run again next time; interrupt again to quit at once.")
    for (const child of running) stop(child)
  }
  process.on("SIGINT", interrupt)
  process.on("SIGTERM", interrupt)

  const execute = async ({ arm, task, run }: { arm: BenchArm; task: BenchTask; run: number }): Promise<RunRecord | undefined> => {
    const dir = runDir(out, arm, task, run)
    // The trace is appended to, so start from an empty directory.
    rmSync(dir, { recursive: true, force: true })
    mkdirSync(dir, { recursive: true })
    const args = [
      "run", "--json", "--headless", "--trace", join(dir, "trace.jsonl"), "--model", arm.model,
      ...(arm.modelOptions ? ["--model-options", JSON.stringify(arm.modelOptions)] : []),
      ...(arm.flags ?? []),
      "--", task.task,
    ]
    const startedAt = new Date().toISOString()
    const started = performance.now()
    const child = Bun.spawn([process.execPath, CLI, ...args], { env, stdin: "ignore", stdout: "pipe", stderr: "pipe" })
    running.add(child)
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      stop(child)
    }, timeoutSeconds * 1000)
    const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    clearTimeout(timer)
    running.delete(child)
    if (interrupted) return undefined
    const meta: RunMeta = {
      arm: arm.name, task: task.id, run, args, exitCode: child.exitCode, signal: child.signalCode, timedOut,
      seconds: Math.round((performance.now() - started) / 100) / 10, startedAt,
    }
    writeFileSync(join(dir, "result.json"), stdout)
    writeFileSync(join(dir, "stderr.log"), stderr)
    // Written last: a run directory without meta.json is unfinished.
    writeFileSync(join(dir, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`)
    return runRecord(meta, { stdout, stderr, trace: readText(join(dir, "trace.jsonl")) })
  }

  const queue = [...pending]
  let done = 0
  const worker = async () => {
    for (let next = queue.shift(); next && !interrupted; next = queue.shift()) {
      const record = await execute(next)
      if (!record) continue
      const error = record.stopReason === "cli_error" && record.error ? `: ${record.error}` : ""
      console.error(`[${++done}/${pending.length}] ${record.arm} ${record.task} #${record.run}: ${record.outcome} (${record.stopReason}), ${record.steps} step${record.steps === 1 ? "" : "s"}, ${record.seconds} s${error}`)
    }
  }
  await Promise.all(Array.from({ length: parallel }, worker))

  const report = compare(arms, tasks, runs, plan.flatMap(({ arm, task, run }) => load(out, arm, task, run) ?? []))
  const summary = renderSummary(report)
  writeFileSync(join(out, "summary.md"), `${summary}\n\n${renderPerTask(report)}\n`)
  writeFileSync(join(out, "summary.json"), `${JSON.stringify({ createdAt: new Date().toISOString(), tasksFile: values.tasks, runTimeoutSeconds: timeoutSeconds, ...report }, null, 2)}\n`)
  console.log(summary)
  console.error(`\nPer-task results: ${join(out, "summary.md")}; every run: ${join(out, "summary.json")}`)
  return interrupted ? 130 : 0
}

/** SIGINT makes the CLI cancel the agent and Playwright close the browser; SIGKILL follows if that hangs. */
function stop(child: Subprocess): void {
  child.kill("SIGINT")
  setTimeout(() => child.kill("SIGKILL"), 10_000).unref()
}

/** Results under one arm name must come from one configuration. Prices only affect the summary. */
function recordArm(out: string, arm: BenchArm): void {
  const file = join(out, "runs", arm.name, "arm.json")
  const recorded = readJsonFile(file)
  const config = ({ model, modelOptions, flags }: BenchArm) => ({ model, modelOptions, flags })
  if (recorded && !Bun.deepEquals(config(recorded as BenchArm), config(arm))) {
    throw new Error(`Arm "${arm.name}" already has runs in ${out} with another model, modelOptions or flags; use a new arm name or output directory`)
  }
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(arm, null, 2)}\n`)
}

function load(out: string, arm: BenchArm, task: BenchTask, run: number): RunRecord | undefined {
  const dir = runDir(out, arm, task, run)
  const meta = readJsonFile(join(dir, "meta.json"))
  if (!meta) return undefined
  return runRecord(meta as RunMeta, { stdout: readText(join(dir, "result.json")), stderr: readText(join(dir, "stderr.log")), trace: readText(join(dir, "trace.jsonl")) })
}

function runDir(out: string, arm: BenchArm, task: BenchTask, run: number): string {
  return join(out, "runs", arm.name, task.id, String(run))
}

function readText(path: string): string | undefined {
  return existsSync(path) ? readFileSync(path, "utf8") : undefined
}

function readJsonFile(path: string): object | undefined {
  try {
    const value: unknown = JSON.parse(readText(path) ?? "")
    return typeof value === "object" && value !== null ? value : undefined
  } catch {
    return undefined
  }
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"))
  } catch (error) {
    throw new Error(`Cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function positiveInteger(value: string | undefined, flag: string): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${flag} must be a positive integer`)
  return parsed
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  },
)

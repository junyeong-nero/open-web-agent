import { parseArgs } from "node:util"
import { modelConfigFromEnv, resolveModel } from "../src/model/resolve"
import { EVALUATION_CASES, evaluateCase, summarize, type EvaluationRun } from "../src/testing/evaluation"
import { startFixtureServer } from "../src/testing/fixture"

async function main() {
  const { values } = parseArgs({ args: process.argv.slice(2), options: {
    live: { type: "boolean" }, model: { type: "string" }, "model-options": { type: "string" },
    case: { type: "string" }, runs: { type: "string", default: "1" }, "max-steps": { type: "string", default: "15" },
    output: { type: "string" }, help: { type: "boolean" },
  } })
  if (values.help) {
    console.log('bun run eval --live --model <provider:model> [--model-options <json>] [--case <id>] [--runs 1] [--max-steps 15] [--output report.json]')
    console.log(`Cases: ${EVALUATION_CASES.map(c => c.id).join(", ")}`)
    return
  }
  if (!values.live) throw new Error("Evaluation may incur API charges. Pass --live to explicitly run it; bun run test never calls real models.")
  const runs = Number(values.runs)
  const maxSteps = Number(values["max-steps"])
  if (!Number.isInteger(runs) || runs < 1 || runs > 10) throw new Error("--runs must be an integer from 1 to 10")
  if (!Number.isInteger(maxSteps) || maxSteps < 1 || maxSteps > 100) throw new Error("--max-steps must be an integer from 1 to 100")
  const cases = EVALUATION_CASES.filter(c => !values.case || c.id === values.case)
  if (!cases.length) throw new Error("Unknown --case; use --help to list cases")
  const config = { ...modelConfigFromEnv({ ...process.env, OWA_MODEL_OPTIONS: values["model-options"] ?? process.env.OWA_MODEL_OPTIONS }), model: values.model ?? process.env.OWA_MODEL }
  const model = await resolveModel(config)
  const fixture = startFixtureServer()
  const results: EvaluationRun[] = []
  try {
    for (let repeat = 0; repeat < runs; repeat++) {
      for (const testCase of cases) {
        const result = await evaluateCase(testCase, model, fixture.url, maxSteps)
        results.push(result)
        console.error(`${result.passed ? "PASS" : "FAIL"} ${testCase.id}: ${result.toolCalls} tools, ${result.durationMs}ms`)
      }
    }
  } finally { fixture.stop() }
  // Record configuration without recording arbitrary option values or authentication.
  const report = { version: 1, createdAt: new Date().toISOString(), model: model.name, config: {
    maxSteps, runs, optionKeys: Object.keys(config.extraBody ?? {}),
    options: Object.fromEntries(Object.entries(config.extraBody ?? {}).filter(([key, value]) => ["reasoning_effort", "temperature", "max_tokens", "max_completion_tokens"].includes(key) && ["string", "number"].includes(typeof value))),
    customModule: Boolean(config.module),
  }, summary: summarize(results), results }
  const json = JSON.stringify(report, null, 2)
  if (values.output) await Bun.write(values.output, json + "\n")
  console.log(json)
  if (results.some(result => !result.passed)) process.exitCode = 1
}

main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1 })

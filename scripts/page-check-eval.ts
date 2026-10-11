import { readFileSync } from "node:fs"
import { parseArgs } from "node:util"
import { resolveModel, roleModelConfig } from "../src/model/resolve"
import { askPageKind, type CheckedPage, PAGE_KINDS, type PageCheckCall, SURE_AT } from "../src/page-check"

const USAGE = `bun scripts/page-check-eval.ts <samples.json> [--checker-model <provider:model>] [--checker-model-options <json>]

Asks the checker model (--checker-model or OWA_CHECKER_MODEL) which kind of page each sample is, once with the labels in
their usual order and once rotated, and prints the accuracy, the confusion between labels and the latency. It calls a
real model API. The samples file is a JSON array of { id, label, url, result, snapshot }: a page's URL, the tool result
text and the snapshot as owa showed them, and the right label. Keep real-site samples outside the repository.`

interface Sample extends CheckedPage {
  id: string
  label: string
}

interface Answer {
  sample: Sample
  order: string
  call: PageCheckCall
}

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({ args: process.argv.slice(2), allowPositionals: true, options: {
    "checker-model": { type: "string" }, "checker-model-options": { type: "string" }, help: { type: "boolean" },
  } })
  const [file] = positionals
  if (values.help || !file) {
    console.log(USAGE)
    return values.help ? 0 : 1
  }
  const samples = parseSamples(JSON.parse(readFileSync(file, "utf8")))
  const config = roleModelConfig("checker", { model: values["checker-model"], options: values["checker-model-options"] })
  if (!config) throw new Error("Pass --checker-model <provider:model> or set OWA_CHECKER_MODEL")
  const model = await resolveModel(config)

  const labels = Object.keys(PAGE_KINDS)
  const orders: Array<[string, string[]]> = [["given", labels], ["rotated", [...labels.slice(3), ...labels.slice(0, 3)]]]
  const answers: Answer[] = []
  // One call at a time, so the latency is the model's alone.
  for (const [order, keys] of orders) {
    const kinds = Object.fromEntries(keys.map((label) => [label, PAGE_KINDS[label]!]))
    for (const sample of samples) {
      const call = await askPageKind(model, sample, new AbortController().signal, kinds)
      answers.push({ sample, order, call })
      const got = call.verdict ? `${call.verdict.label.padEnd(15)} p=${call.verdict.confidence.toFixed(2)}` : `error: ${call.error}`
      console.log(`${call.verdict?.label === sample.label ? "ok " : "BAD"} ${order.padEnd(7)} ${sample.id.padEnd(34)} want ${sample.label.padEnd(15)} got ${got}  ${call.durationMs} ms, ${call.response?.usage?.inputTokens ?? "?"} in`)
    }
  }

  console.log(`\nmodel ${model.name}, served by ${[...new Set(answers.map(({ call }) => call.response?.model ?? "?"))].join(", ")}`)
  const right = (list: Answer[]) => list.filter(({ sample, call }) => call.verdict?.label === sample.label).length
  console.log(`accuracy ${right(answers)}/${answers.length} (${orders.map(([order]) => `${order} ${right(answers.filter((answer) => answer.order === order))}/${samples.length}`).join(", ")})`)
  const sure = answers.filter(({ call }) => call.verdict && call.verdict.confidence >= SURE_AT)
  console.log(`at confidence ${SURE_AT} or more: ${sure.length} answers, ${right(sure)} right`)
  console.log("confusion (right label: answers)")
  for (const label of labels) {
    const got = answers.filter(({ sample }) => sample.label === label).map(({ call }) => call.verdict?.label ?? "error")
    if (got.length) console.log(`  ${label.padEnd(15)} ${[...count(got)].map(([answer, n]) => `${answer} ${n}`).join(", ")}`)
  }
  const replied = answers.filter(({ call }) => call.response)
  const ms = replied.map(({ call }) => call.durationMs).sort((a, b) => a - b)
  const tokens = replied.reduce((sum, { call }) => sum + (call.response?.usage?.inputTokens ?? 0), 0)
  console.log(`latency median ${ms[Math.floor(ms.length / 2)] ?? "-"} ms, max ${ms.at(-1) ?? "-"} ms; input tokens ${tokens} (${replied.length ? Math.round(tokens / replied.length) : 0} per call); no kind ${answers.filter(({ call }) => !call.verdict).length}`)
  return 0
}

function parseSamples(value: unknown): Sample[] {
  if (!Array.isArray(value) || !value.length) throw new Error("The samples file must be a non-empty JSON array")
  return value.map((sample, index) => {
    const fields = ["id", "label", "url", "result", "snapshot"] as const
    if (!sample || typeof sample !== "object" || fields.some((field) => typeof sample[field] !== "string")) {
      throw new Error(`Sample ${index} needs string fields ${fields.join(", ")}`)
    }
    if (!Object.hasOwn(PAGE_KINDS, sample.label)) throw new Error(`Sample ${sample.id} has unknown label "${sample.label}"; labels: ${Object.keys(PAGE_KINDS).join(", ")}`)
    return { id: sample.id, label: sample.label, url: sample.url, result: sample.result, snapshot: sample.snapshot }
  })
}

function count(values: string[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1)
  return counts
}

main().then((code) => { process.exitCode = code }, (error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})

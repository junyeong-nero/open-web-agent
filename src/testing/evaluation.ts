import { runAgent, type AgentEvent, type AgentResult } from "../agent"
import { BrowserSession } from "../browser"
import type { ModelAdapter } from "../model/types"

interface EvaluationContext {
  browser: BrowserSession
  result: AgentResult
  events: AgentEvent[]
}
export interface EvaluationCase {
  id: string
  task(baseUrl: string): string
  verify(context: EvaluationContext): Promise<Record<string, boolean>>
}

export const EVALUATION_CASES: EvaluationCase[] = [
  {
    id: "price",
    task: (url) => `Open ${url}/ and follow Pricing. Report the Pro price and billing period.`,
    async verify({ browser, result }) {
      return { pricingVisited: browser.currentUrl?.endsWith("/pricing") ?? false, price: /\$42\b/.test(result.answer), monthly: /month|월/i.test(result.answer) }
    },
  },
  {
    id: "search-filter",
    task: (url) => `Open ${url}/. Search for evaluation-query using the input and Search button. Choose Pro in the Plan dropdown. Report the search result.`,
    async verify({ browser, result }) {
      const page = await browser.page()
      return {
        input: await page.locator("#q").inputValue() === "evaluation-query",
        searched: await page.locator("#out").innerText() === "Searched evaluation-query",
        selected: await page.locator("select").inputValue() === "pro",
        answer: result.answer.includes("evaluation-query"),
      }
    },
  },
  {
    id: "async-result",
    task: (url) => `Open ${url}/async. Click Start lookup, wait for the result, and report the confirmation code.`,
    async verify({ browser, result }) {
      return { loaded: await (await browser.page()).locator("#result").innerText() === "READY-314", answer: result.answer.includes("READY-314") }
    },
  },
  {
    id: "ref-recovery",
    task: (url) => `Open ${url}/. For this recovery check, first attempt browser_click with stale ref e999999. Then recover using a fresh snapshot, enter recovered in Search, click Search, and report its result.`,
    async verify({ browser, result, events }) {
      const tools = events.filter((event) => event.type === "tool")
      const failed = tools.findIndex(event => event.call.name === "browser_click" && event.call.arguments.ref === "e999999" && event.result.isError)
      return {
        attemptedStaleRef: failed >= 0,
        recovered: failed >= 0 && tools.slice(failed + 1).some(event => event.call.name === "browser_click" && !event.result.isError),
        searched: await (await browser.page()).locator("#out").innerText() === "Searched recovered",
        answer: result.answer.includes("recovered"),
      }
    },
  },
  {
    id: "tab-return",
    task: (url) => `Open ${url}/ and enter comparison-note in Search without submitting. Use Pricing in new tab to read the price. Return to the original tab without reloading or navigating it; preserve its input. Report the price and preserved input.`,
    async verify({ browser, result }) {
      const page = await browser.page()
      const pages = page.context().pages()
      return {
        twoTabs: pages.length === 2,
        originalSelected: new URL(page.url()).pathname === "/",
        originalPreserved: new URL(page.url()).pathname === "/" && await page.locator("#q").inputValue() === "comparison-note",
        priceTabPreserved: pages.some(p => new URL(p.url()).pathname === "/pricing"),
        answer: /\$42\b/.test(result.answer) && result.answer.includes("comparison-note"),
      }
    },
  },
  {
    id: "lowest-price",
    task: (url) => `Open ${url}/products and find the lowest-priced Dyson Airwrap. Report its product name and price in KRW.`,
    async verify({ result }) {
      return {
        name: result.answer.includes("Dyson Airwrap Origin Multi Styler and Dryer"),
        price: /\b389,?430\b/.test(result.answer),
      }
    },
  },
]

export interface EvaluationRun {
  caseId: string
  passed: boolean
  checks: Record<string, boolean>
  durationMs: number
  toolCalls: number
  toolErrors: number
  result?: AgentResult
  error?: string
}

/** Separate from unit tests: callers explicitly supply the live or scripted model. */
export async function evaluateCase(testCase: EvaluationCase, model: ModelAdapter, baseUrl: string, maxSteps = 15): Promise<EvaluationRun> {
  const browser = new BrowserSession({ headless: true, actionTimeoutMs: 5_000 })
  const startedAt = performance.now()
  const events: AgentEvent[] = []
  const report: EvaluationRun = { caseId: testCase.id, passed: false, checks: {}, durationMs: 0, toolCalls: 0, toolErrors: 0 }
  try {
    report.result = await runAgent({ task: testCase.task(baseUrl), model, browser, maxSteps, timeoutMs: 120_000, onEvent: event => events.push(event) })
    report.checks = report.result.status === "completed"
      ? await testCase.verify({ browser, result: report.result, events })
      : { executionCompleted: false }
    // A model's success claim never determines the evaluation verdict.
    report.passed = report.result.status === "completed" && Object.values(report.checks).every(Boolean)
  } catch (error) {
    report.error = error instanceof Error ? error.message : String(error)
  } finally {
    report.durationMs = Math.round(performance.now() - startedAt)
    report.toolCalls = events.filter(event => event.type === "tool").length
    report.toolErrors = events.filter(event => event.type === "tool" && event.result.isError).length
    await browser.close()
  }
  return report
}

export function summarize(runs: EvaluationRun[]) {
  return {
    runs: runs.length,
    passed: runs.filter(run => run.passed).length,
    successRate: runs.length ? runs.filter(run => run.passed).length / runs.length : 0,
    durationMs: runs.reduce((sum, run) => sum + run.durationMs, 0),
    toolCalls: runs.reduce((sum, run) => sum + run.toolCalls, 0),
    toolErrors: runs.reduce((sum, run) => sum + run.toolErrors, 0),
    inputTokens: runs.reduce((sum, run) => sum + (run.result?.usage.inputTokens ?? 0), 0),
    outputTokens: runs.reduce((sum, run) => sum + (run.result?.usage.outputTokens ?? 0), 0),
  }
}

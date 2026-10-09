import { afterEach, beforeEach, expect, test } from "bun:test"
import { systemOneDriver, type SystemOneDriverOptions } from "../examples/systemone-driver"
import { resolveModel } from "./model/resolve"
import type { FetchLike, ModelRequest, ModelResponse } from "./model/types"
import { scriptedModel } from "./testing/scripted-model"

const secret = "offline-typesafe-secret"
let previousKey: string | undefined
beforeEach(() => {
  previousKey = process.env.TYPESAFE_API_KEY
  process.env.TYPESAFE_API_KEY = secret
})
afterEach(() => {
  if (previousKey === undefined) delete process.env.TYPESAFE_API_KEY
  else process.env.TYPESAFE_API_KEY = previousKey
})
const snapshot = `Page URL: https://example.test/search
Page title: Travel
Page tab: 1
Snapshot:
Open dialog (shown first; the page behind it may not accept clicks):
- dialog "Find a flight":
  - textbox "Where from?" [ref=f8e35]: Pune
  - button "Search" [ref=e50] [cursor=pointer]
Rest of the page:
- heading "Cheap flights"
- paragraph: Pick your trip
- text: Visible facts
- cell "USD 120"
- checkbox "Nonstop only" [checked] [ref=e4]
- radio "Economy" [checked=false] [ref=e5]
- switch "Offers" [ref=e6]
- tab "Flights" [selected] [active] [ref=e7]
- menuitemcheckbox "Menu" [ref=e8]
- treeitem "Route" [expanded] [ref=e9]
- gridcell "Seat" [ref=e10]
- option "Suggestion" [ref=e11]
- generic "Custom" [ref=e12] [cursor=pointer]
- link "Airline" [ref=e13]:
  - /url: /airline
- searchbox "Query" [ref=e14]
- spinbutton "Passengers" [ref=e15]: 2
- combobox "City" [ref=e16]: Pune
- combobox "Sort by" [ref=e111]:
  - option "Price: Low to High" [selected]
  - option "Price: High to Low"
  - option "Unavailable" [disabled]
- listbox "Cabin" [ref=e20]:
  - option "Business"
- button "Disabled" [disabled] [ref=e99]
- button "Disabled too" [disabled=true] [ref=e100]`
const names = ["browser_click", "browser_type", "browser_select_option", "browser_scroll", "browser_wait_for", "browser_go_back", "browser_get_text"]
function request(page = snapshot): ModelRequest {
  return { system: "Original system", messages: [{ role: "user", content: [{ type: "text", text: `Task: Find flights from Pune\n\nCurrent page:\n${page}` }] }], tools: names.map((name) => ({ name, description: name, inputSchema: {} })) }
}
const llmResponse: ModelResponse = { model: "llm-model", usage: { inputTokens: 31, outputTokens: 7, cost: 0.1 }, toolCalls: [{ id: "llm-call", name: "browser_get_text", arguments: {} }] }
type Body = {
  model: string
  state: {
    goal: string
    page: { url: string, title: string, text: string }
    elements: Array<{ ref: string, index: number, role: string, name: string, value: string, states: string[] }>
    recent_actions: Array<{ tool: string, args: Record<string, unknown>, result: string, error: boolean }>
  }
  questions: Record<string, { type: string, criteria: Record<string, string>, instructions: Record<string, string> }>
}
function response(body: Body, operation = "CLICK", target = "e50", confidence = 0.93) {
  const answers = Object.fromEntries(Object.entries(body.questions).map(([key, question]) => {
    const choice = key === "operation" ? operation : target
    return [key, { choice, confidence, probabilities: Object.fromEntries(Object.keys(question.criteria).map((key, i) => [key, i === 0 ? 1 : 0])) }]
  }))
  return { model: "jev-1.13.0", answers, usage: { input_tokens: 100, output_tokens: 4 } }
}
async function setup(operation = "CLICK", target = "e50", options: SystemOneDriverOptions = {}, confidence = 0.93) {
  const bodies: Body[] = []
  const inits: RequestInit[] = []
  const urls: string[] = []
  const llm = scriptedModel([() => llmResponse])
  const driver = await systemOneDriver({ llm, fetch: async (url, init) => {
    urls.push(url)
    inits.push(init)
    const body = JSON.parse(init.body as string) as Body
    bodies.push(body)
    return Response.json(response(body, operation, target, confidence))
  }, ...options })
  return { driver, bodies, inits, urls, llm }
}

test("table preserves dialog order, roles, values, states and native select targets", async () => {
  const { driver, bodies } = await setup()
  await driver.complete(request())
  const { state, questions } = bodies[0]
  expect(state.goal).toBe("Find flights from Pune")
  expect(state.elements[0]).toMatchObject({ index: 0, ref: "f8e35", role: "textbox", name: "Where from?", value: "Pune" })
  expect(state.elements.find((e) => e.ref === "e4")?.states).toEqual(["checked"])
  expect(state.elements.find((e) => e.ref === "e5")?.states).toEqual(["checked=false"])
  expect(state.elements.find((e) => e.ref === "e7")?.states).toEqual(["selected", "active"])
  expect(state.elements.find((e) => e.ref === "e9")?.states).toEqual(["expanded"])
  expect(state.elements.some((e) => ["e99", "e100"].includes(e.ref))).toBe(false)
  expect(Object.keys(questions.type_target.criteria)).toEqual(["f8e35", "e14", "e15", "e16"])
  expect(Object.keys(questions.click_target.criteria)).toEqual(["e50", "e4", "e5", "e6", "e7", "e8", "e9", "e10", "e11", "e12", "e13", "e16", "e111"])
  expect(Object.keys(questions.select_target.criteria)).toEqual(["e111:0", "e111:1", "e20:0"])
  expect(questions.select_target.criteria["e111:0"]).toContain("Price: Low to High")
  expect(questions.select_target.criteria["e111:0"]).toContain("selected")
  expect(questions.type_target.criteria.f8e35).toContain("value: Pune")
  expect(state.page.text).toBe("Find a flight\nCheap flights\nPick your trip\nVisible facts\nUSD 120")
})

test("CLICK returns a unique call, chosen ref, marker and Jev accounting", async () => {
  const { driver, llm } = await setup()
  const result = await driver.complete(request())
  expect(result).toMatchObject({ model: "jev-1.13.0", usage: { inputTokens: 100, outputTokens: 4 }, toolCalls: [{ name: "browser_click", arguments: { ref: "e50", element: "Search [jev CLICK 0.93]" } }] })
  expect((await driver.complete(request())).toolCalls[0].id).not.toBe(result.toolCalls[0].id)
  expect(result.toolCalls[0].id).toStartWith("jev-")
  expect(llm.requests).toHaveLength(0)
})

test("SELECT uses the option label and parent ref", async () => {
  const { driver } = await setup("SELECT", "e111:1")
  expect((await driver.complete(request())).toolCalls[0]).toMatchObject({ name: "browser_select_option", arguments: { ref: "e111", values: ["Price: High to Low"], element: "Sort by [jev SELECT 0.93]" } })
})

test("single-quoted YAML scalars preserve names, refs, states and values", async () => {
  const page = `Page URL: https://example.test
- 'button "다음: 해변 여행을 계획 중이신가요?" [ref=e852] [cursor=pointer]':
- 'link "Get $50 off instantly: Pay $0.00 $9.99 upon approval" [ref=e472] [cursor=pointer]'
- 'textbox "Traveler''s name: full" [ref=e853] [active]': O'Brien
- 'textbox "Time: departure" [ref=e854]: 10:30'`
  const { driver, bodies } = await setup("CLICK", "e852")
  const result = await driver.complete(request(page))
  expect(result.toolCalls[0]).toMatchObject({ name: "browser_click", arguments: { ref: "e852" } })
  const { state, questions } = bodies[0]
  expect(questions.click_target.criteria.e852).toContain('button "다음: 해변 여행을 계획 중이신가요?"')
  expect(state.elements.find((e) => e.ref === "e852")?.name).toBe("다음: 해변 여행을 계획 중이신가요?")
  expect(state.elements.find((e) => e.ref === "e472")?.name).toBe("Get $50 off instantly: Pay $0.00 $9.99 upon approval")
  expect(state.elements.find((e) => e.ref === "e853")).toMatchObject({ name: "Traveler's name: full", value: "O'Brien", states: ["active"] })
  expect(state.elements.find((e) => e.ref === "e854")?.value).toBe("10:30")
})

test("native options use SELECT while ref'd listbox and combobox suggestions use CLICK", async () => {
  const page = `Page URL: https://example.test
- combobox "Select the department you want to search in" [ref=e31] [cursor=pointer]:
  - option "All Departments" [selected]
  - option "Arts & Crafts"
- listbox "추천 여행지 목록" [ref=e3273]:
  - option "Ohio United States of America" [ref=e3274]:
- combobox "Destination" [ref=e40]:
  - option "Pune" [ref=e41]
  - option "Disabled suggestion" [ref=e42] [disabled]`
  const { driver, bodies } = await setup("CLICK", "e3274")
  const result = await driver.complete(request(page))
  expect(result.toolCalls[0]).toMatchObject({ name: "browser_click", arguments: { ref: "e3274" } })
  const { questions } = bodies[0]
  expect(Object.keys(questions.select_target.criteria)).toEqual(["e31:0", "e31:1"])
  expect(questions.select_target.criteria["e31:1"]).toContain("Arts & Crafts")
  expect(Object.keys(questions.click_target.criteria)).toEqual(["e31", "e3274", "e40", "e41"])
  expect(Object.keys(questions.type_target.criteria)).toEqual(["e40"])
})

test("state.elements is exactly the union of capped targets with matching indices", async () => {
  const page = snapshot.replace("Snapshot:\n", 'Snapshot:\n- generic [ref=e200]\n- img "Logo" [ref=e201]\n')
  for (const maxTargets of [1, 250]) {
    const { driver, bodies } = await setup("CLICK", "e50", { maxTargets })
    await driver.complete(request(page))
    const { state, questions } = bodies[0]
    const criteria = Object.entries(questions).filter(([head]) => head !== "operation").flatMap(([, question]) => Object.entries(question.criteria))
    const refs = new Set(criteria.map(([id]) => id.split(":")[0]))
    expect(new Set(state.elements.map((e) => e.ref))).toEqual(refs)
    expect(state.elements).toHaveLength(refs.size)
    expect(state.elements.some((e) => ["e200", "e201"].includes(e.ref))).toBe(false)
    for (const [id, description] of criteria) {
      const element = state.elements.find((e) => e.ref === id.split(":")[0])!
      expect(description).toStartWith(`[${element.index}]`)
    }
  }
})

test("compact page text includes value-only lines and excludes URLs and empty values", async () => {
  const { driver, bodies } = await setup("READ_TEXT")
  await driver.complete(request(`Page URL: https://example.test
- generic [ref=e264]: KRW 517,207
- text: From $449
- generic [ref=e265]:
- text:
- /url: /not-visible
- 'generic [ref=e266]: Price: $20'`))
  expect(bodies[0].state.page.text).toBe("KRW 517,207\nFrom $449\nPrice: $20")
  expect(bodies[0].state.elements).toEqual([])
})

for (const fence of ["```json", "```", "```JSON"]) {
  test(`TYPE_TEXT accepts a fenced JSON helper reply: ${fence}`, async () => {
    const llm = scriptedModel([() => ({
      ...llmResponse, toolCalls: [],
      text: ["", fence, '{"text":"Mumbai","submit":true}', "```", ""].join("\n"),
    })])
    const { driver } = await setup("TYPE_TEXT", "f8e35", { llm })
    const result = await driver.complete(request())
    expect(result).toMatchObject({ model: llmResponse.model, usage: llmResponse.usage, toolCalls: [{ name: "browser_type", arguments: { ref: "f8e35", text: "Mumbai", submit: true } }] })
    expect(result.toolCalls[0].id).toStartWith("jev-")
    expect(llm.requests).toHaveLength(1)
  })
}

test("TYPE_TEXT uses a tool-less helper with field context and only LLM accounting", async () => {
  const llm = scriptedModel([(r) => {
    expect(r.tools).toEqual([])
    expect(r.system).toContain("Never invent personal data")
    const msg = r.messages[0]
    expect(msg.role === "user" && msg.content[0].type === "text" && JSON.parse(msg.content[0].text)).toMatchObject({ goal: "Find flights from Pune", field: { role: "textbox", label: "Where from?", currentValue: "Pune" }, page: { url: "https://example.test/search", title: "Travel", text: expect.stringContaining("Cheap flights") }, recent_actions: [] })
    return { ...llmResponse, toolCalls: [], text: '{"text":"Mumbai","submit":false}' }
  }])
  const { driver } = await setup("TYPE_TEXT", "f8e35", { llm })
  expect(await driver.complete(request())).toMatchObject({ model: llmResponse.model, usage: llmResponse.usage, toolCalls: [{ name: "browser_type", arguments: { ref: "f8e35", text: "Mumbai", submit: false } }] })
})

for (const text of ["not json", '{"text":"","submit":false}', '{"text":"hello","submit":"yes"}']) {
  test(`invalid typed text falls back: ${text}`, async () => {
    const original = request()
    const llm = scriptedModel([() => ({ text, toolCalls: [] }), (r) => {
      expect(r).toBe(original)
      return llmResponse
    }])
    const { driver } = await setup("TYPE_TEXT", "f8e35", { llm })
    expect(await driver.complete(original)).toBe(llmResponse)
  })
}

for (const operation of ["DONE", "BLOCKED", "CLICK"]) {
  test(`${operation} fallback returns the LLM's unchanged full-request response`, async () => {
    const original = request()
    const llm = scriptedModel([(r) => {
      expect(r).toBe(original)
      return llmResponse
    }])
    const { driver } = await setup(operation, "e50", { llm }, operation === "CLICK" ? 0.59 : 0.99)
    expect(await driver.complete(original)).toBe(llmResponse)
  })
}

for (const [operation, tool, args] of [
  ["SCROLL_DOWN", "browser_scroll", { direction: "down" }], ["SCROLL_UP", "browser_scroll", { direction: "up" }],
  ["WAIT", "browser_wait_for", { seconds: 2 }], ["GO_BACK", "browser_go_back", {}], ["READ_TEXT", "browser_get_text", {}],
] as const) {
  test(`${operation} maps to the exact tool arguments`, async () => {
    const { driver } = await setup(operation)
    expect((await driver.complete(request())).toolCalls[0]).toMatchObject({ name: tool, arguments: args })
  })
}

test("tool-less and non-http pages bypass Jev", async () => {
  for (const original of [request("Page URL: about:blank"), request("No snapshot"), { ...request(), tools: [] }]) {
    const { driver, bodies } = await setup()
    expect(await driver.complete(original)).toBe(llmResponse)
    expect(bodies).toHaveLength(0)
  }
})

test("missing selected tool falls back", async () => {
  const { driver } = await setup()
  const original = request()
  original.tools = original.tools.filter((tool) => tool.name !== "browser_click")
  expect(await driver.complete(original)).toBe(llmResponse)
})

test("body uses choice heads, caps each head, and only authenticates in the header", async () => {
  const { driver, bodies, inits, urls } = await setup("CLICK", "e50", { maxTargets: 1, systemOneModel: "custom-jev", systemOneUrl: "https://offline.test/systemone" })
  await driver.complete(request())
  const body = bodies[0]
  expect(body.model).toBe("custom-jev")
  expect(urls).toEqual(["https://offline.test/systemone"])
  expect(Object.keys(body.questions)).toEqual(["operation", "click_target", "type_target", "select_target"])
  for (const [key, question] of Object.entries(body.questions)) {
    expect(question.type).toBe("choice")
    expect(question.instructions.goal).toBe(body.state.goal)
    if (key !== "operation") expect(Object.keys(question.criteria)).toHaveLength(1)
  }
  expect(inits[0].headers).toMatchObject({ Authorization: `Bearer ${secret}` })
  expect(JSON.stringify(body)).not.toContain(secret)
  expect(JSON.stringify(urls)).not.toContain(secret)
})

test("empty tables omit target heads and target operations; compact text is bounded", async () => {
  const { driver, bodies } = await setup("READ_TEXT")
  await driver.complete(request(`Page URL: https://example.test\nPage title: Text\n- paragraph: ${"x".repeat(7000)}`))
  expect(Object.keys(bodies[0].questions)).toEqual(["operation"])
  expect(Object.keys(bodies[0].questions.operation.criteria)).toEqual(["SCROLL_DOWN", "SCROLL_UP", "WAIT", "GO_BACK", "READ_TEXT", "DONE", "BLOCKED"])
  expect(bodies[0].state.page.text).toHaveLength(6000)
})

test("newest tool snapshot wins; recent actions retain the last eight paired results", async () => {
  const original = request()
  for (let i = 0; i < 10; i++) {
    original.messages.push({ role: "assistant", toolCalls: [{ id: String(i), name: "browser_type", arguments: { text: "x".repeat(1000), ref: "e1" } }] })
    original.messages.push({ role: "tool", name: "browser_type", toolCallId: String(i), isError: i === 9, content: [{ type: "text", text: `Result ${i}\nMore detail` }, { type: "text", text: i === 9 ? 'Page URL: https://new.test\nPage title: New\n- button "New" [ref=e200]' : "[Earlier snapshot omitted]" }] })
  }
  const { driver, bodies } = await setup("CLICK", "e200")
  expect((await driver.complete(original)).toolCalls[0].arguments.ref).toBe("e200")
  const state = bodies[0].state
  expect(state.page.url).toBe("https://new.test")
  expect(state.recent_actions).toHaveLength(8)
  expect(state.recent_actions[0].result).toBe("Result 2")
  expect(state.recent_actions[7]).toMatchObject({ tool: "browser_type", result: "Result 9", error: true })
  expect((state.recent_actions[0].args.text as string).length).toBeLessThan(200)
})

for (const bad of ["choice", "target", "sum", "range", "confidence", "missing", "target-confidence"]) {
  test(`invalid or uncertain answer falls back: ${bad}`, async () => {
    const fetch: FetchLike = async (_, init) => {
      const reply = response(JSON.parse(init.body as string))
      if (bad === "choice") reply.answers.operation.choice = "INVENTED"
      if (bad === "target") reply.answers.click_target.choice = "stale-ref"
      if (bad === "sum") reply.answers.operation.probabilities.CLICK = 0.2
      if (bad === "range") reply.answers.operation.probabilities.CLICK = -1
      if (bad === "confidence") reply.answers.operation.confidence = NaN
      if (bad === "missing") delete (reply.answers as Record<string, unknown>).operation
      if (bad === "target-confidence") reply.answers.click_target.confidence = 0.2
      return Response.json(reply)
    }
    const { driver } = await setup("CLICK", "e50", { fetch })
    expect(await driver.complete(request())).toBe(llmResponse)
  })
}

for (const status of [429, 529]) {
  test(`${status} retries exactly once and can succeed`, async () => {
    let count = 0
    const fetch: FetchLike = async (_, init) => ++count === 1 ? new Response("retry", { status }) : Response.json(response(JSON.parse(init.body as string)))
    const { driver } = await setup("CLICK", "e50", { fetch })
    expect((await driver.complete(request())).model).toBe("jev-1.13.0")
    expect(count).toBe(2)
  })
}

for (const status of [500, 429, 529]) {
  test(`HTTP ${status} ultimately falls back`, async () => {
    let count = 0
    const { driver } = await setup("CLICK", "e50", { fetch: async () => {
      count++
      return new Response("failure", { status })
    } })
    expect(await driver.complete(request())).toBe(llmResponse)
    expect(count).toBe(status === 500 ? 1 : 2)
  })
}

test("network error and malformed JSON fall back", async () => {
  for (const fetch of [async () => { throw new Error("offline") }, async () => new Response("not json")]) {
    const { driver } = await setup("CLICK", "e50", { fetch })
    expect(await driver.complete(request())).toBe(llmResponse)
  }
})

test("cancellation bounds a fetch that ignores the signal and preserves the original fallback request", async () => {
  const controller = new AbortController()
  const original = { ...request(), signal: controller.signal }
  const llm = scriptedModel([(r) => {
    expect(r).toBe(original)
    return llmResponse
  }])
  const { driver } = await setup("CLICK", "e50", { llm, fetch: async (_, init) => {
    expect(init.signal).toBeDefined()
    controller.abort()
    return new Promise<Response>(() => {})
  } })
  expect(await driver.complete(original)).toBe(llmResponse)
})

test("timeout bounds a stalled request", async () => {
  const { driver } = await setup("CLICK", "e50", { fetch: async () => new Promise<Response>(() => {}) })
  expect(await driver.complete(request())).toBe(llmResponse)
}, 10000)

test("creation requires the key and validates option bounds", async () => {
  delete process.env.TYPESAFE_API_KEY
  expect(systemOneDriver({ llm: scriptedModel([]) })).rejects.toThrow("TYPESAFE_API_KEY")
  process.env.TYPESAFE_API_KEY = secret
  for (const options of [{ maxTargets: 256 }, { maxTargets: 0 }, { minConfidence: NaN }, { minConfidence: -1 }]) {
    expect(systemOneDriver({ llm: scriptedModel([]), ...options })).rejects.toThrow()
  }
})

test("resolveModel loads the default module factory with extraBody options", async () => {
  const driver = await resolveModel({ module: "./examples/systemone-driver.ts", extraBody: { llm: "ollama:offline", llmOptions: {} } })
  expect(driver.name).toBe("systemone-driver")
})

test("logFile records one line per step with Jev's operation and who acted", async () => {
  const { mkdtempSync } = await import("node:fs")
  const { tmpdir } = await import("node:os")
  const dir = mkdtempSync(`${tmpdir()}/owa-driver-log-`)
  const logFile = `${dir}/decisions.jsonl`
  const jev = await setup("CLICK", "e50", { logFile })
  await jev.driver.complete(request())
  const low = await setup("CLICK", "e50", { logFile }, 0.3)
  await low.driver.complete(request())
  const done = await setup("DONE", "e50", { logFile })
  await done.driver.complete(request())
  const lines = (await Bun.file(logFile).text()).trim().split("\n").map((line) => JSON.parse(line))
  expect(lines.map((line) => line.outcome)).toEqual(["jev:CLICK", "llm:low-confidence", "llm:done"])
  expect(lines[0]).toMatchObject({ goal: "Find flights from Pune", url: "https://example.test/search", operation: "CLICK", confidence: 0.93, jevInputTokens: 100 })
  expect(JSON.stringify(lines)).not.toContain(secret)
})

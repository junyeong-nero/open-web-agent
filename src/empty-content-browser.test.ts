import { afterAll, afterEach, beforeEach, expect, it } from "bun:test"
import { BrowserSession } from "./browser"
import { refFor, startFixtureServer } from "./testing/fixture"
import { callTool, selectTools } from "./tools"

const fixture = startFixtureServer()
const tools = selectTools()
const notice = "The page loaded, but its content is empty: the URL may not exist, or the content may still be loading."
let session: BrowserSession
const call = (name: string, args: unknown = {}) => callTool(tools, session, name, args)

beforeEach(() => { session = new BrowserSession({ headless: true }) })
afterEach(async () => { await session.close() })
afterAll(() => { fixture.stop() })

it("flags a committed HTTP 200 shell on navigate and go back", async () => {
  const result = await call("browser_navigate", { url: `${fixture.url}/empty-content` })
  expect(result.isError).toBeUndefined()
  expect(result.text).toContain(notice)
  expect(result.text).not.toContain("HTTP")
  expect(result.snapshot).toContain("main")
  await call("browser_navigate", { url: `${fixture.url}/short-content` })
  expect((await call("browser_go_back")).text).toContain(notice)
})

for (const path of ["/", "/short-content", "/content-outside-main"]) {
  it(`does not flag real content at ${path}`, async () => {
    const result = await call("browser_navigate", { url: `${fixture.url}${path}` })
    expect(result.isError).toBeUndefined()
    expect(result.text).not.toContain(notice)
  })
}

it("flags a click that navigates to an empty shell", async () => {
  const { snapshot } = await call("browser_navigate", { url: `${fixture.url}/short-content` })
  const result = await call("browser_click", { ref: refFor(snapshot!, /link "Empty shell"/) })
  expect(result.isError).toBeUndefined()
  expect(result.text).toContain(notice)
})

it("does not flag read-only snapshots or actions that stay on the document", async () => {
  await call("browser_navigate", { url: `${fixture.url}/empty-content` })
  const snapshot = await call("browser_snapshot")
  expect(snapshot.text).not.toContain(notice)
  const clicked = await call("browser_click", { ref: refFor(snapshot.snapshot!, /button "Menu"/) })
  expect(clicked.isError).toBeUndefined()
  expect(clicked.text).not.toContain(notice)
})

it("checks the final settled content", async () => {
  const page = await session.page()
  await page.route("**/render-content", (route) => route.fulfill({ contentType: "text/html", body: `
    <header>Loading</header><main></main><script>
      fetch('/late-data?ms=300').then(() => {
        document.querySelector('main').textContent = 'Explore the neighborhood on foot and discover its parks, cafes, and quiet streets.'
      })
    </script>` }))
  const result = await call("browser_navigate", { url: `${fixture.url}/render-content` })
  expect(result.isError).toBeUndefined()
  expect(result.snapshot).toContain("Explore the neighborhood")
  expect(result.text).not.toContain(notice)
})

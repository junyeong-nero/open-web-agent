import { afterAll, expect, it } from "bun:test"
import { BrowserSession } from "./browser"
import { startFixtureServer } from "./testing/fixture"

let fixture: ReturnType<typeof startFixtureServer> | undefined
const session = new BrowserSession({ headless: true })
const marker = "Open dialog (shown first; the page behind it may not accept clicks):"
const notice = (max: number) => `\n… [snapshot truncated at ${max} chars]`

afterAll(async () => {
  await session.close()
  fixture?.stop()
})

for (const variant of ["empty", "mixed", "wrappers"]) {
  it(`keeps empty dialogs in the page (${variant})`, async () => {
    fixture ??= startFixtureServer()
    const page = await session.page()
    await page.goto(`${fixture.url}/empty-dialogs?variant=${variant}`)
    await session.snapshot()
    const tree = session.lastSnapshot!.tree
    expect(tree.length).toBeGreaterThan(40_000)
    expect(tree).toMatch(/- dialog(?: \[ref=\w+\])?:? *$/m)
    const shown = session.shown(tree)
    if (variant === "mixed") {
      const [front, rest] = shown.split("\nRest of the page:\n")
      expect(front).toStartWith(`${marker}\n- dialog "Useful dialog"`)
      expect(front).toContain('heading "Dialog content"')
      expect(front).toContain('button "Continue"')
      expect(front).not.toMatch(/- dialog(?: \[ref=\w+\])?:? *$/m)
      expect(rest).toContain('heading "Page content"')
      expect(rest).toMatch(/- dialog(?: \[ref=\w+\])?:? *$/m)
      expect(rest).not.toContain('dialog "Useful dialog"')
    } else {
      expect(shown).toBe(tree.slice(0, 40_000) + notice(40_000))
      expect(shown).not.toContain(marker)
      expect(shown).toContain('heading "Page content"')
      if (variant === "wrappers") expect(shown).toContain('dialog "Empty wrappers"')
    }
  })
}

const empty = [
  "- dialog",
  "- dialog [ref=e2]",
  "- dialog [ref=e2]:   ",
  '- dialog "Label only" [ref=e2]',
  '- alertdialog "Label only" [active] [ref=e2]:  ',
  "- 'dialog \"Label: only\" [ref=e2]':   ",
  '- dialog "Escaped \\"label\\"" [ref=e2]:',
  "- dialog [ref=e2]:\n  \n  - generic [ref=e3]:\n    - generic [ref=e4]",
  "- dialog [ref=e2]:\n  - group [ref=e3]:\n    - paragraph [ref=e4]:   ",
]

for (const dialog of empty) {
  it(`uses plain truncation for empty snapshot text: ${JSON.stringify(dialog)}`, () => {
    const tree = `- main [ref=e1]: Page\n${dialog}\n- paragraph [ref=e9]: ${"filler ".repeat(100)}`
    expect(new BrowserSession({ maxSnapshotChars: 300 }).shown(tree)).toBe(tree.slice(0, 300) + notice(300))
  })
}

const content = [
  "- dialog [ref=e2]: Content",
  "- alertdialog [ref=e2]: Content",
  "- 'dialog \"Label: only\" [ref=e2]': Content",
  '- dialog [ref=e2]:\n  - generic "Named wrapper" [ref=e3]',
  '- dialog [ref=e2]:\n  - generic "" [ref=e3]',
  "- dialog [ref=e2]:\n  - generic [ref=e3]: Content",
  "- dialog [ref=e2]:\n  - text: Content",
  "- dialog [ref=e2]:\n  - button [ref=e3]",
  "- dialog [ref=e2]:\n  - textbox [ref=e3]",
  "- dialog [ref=e2]:\n  - generic [ref=e3]:\n    - button [ref=e4]",
]

for (const dialog of content) {
  it(`promotes snapshot text with content: ${JSON.stringify(dialog)}`, () => {
    const tree = `- main [ref=e1]: Page\n${dialog}\n- paragraph [ref=e9]: ${"filler ".repeat(100)}`
    expect(new BrowserSession({ maxSnapshotChars: 300 }).shown(tree)).toStartWith(`${marker}\n${dialog}\nRest of the page:\n- main [ref=e1]: Page`)
  })
}

it("leaves empty active dialogs in place when promoting a populated dialog", () => {
  const rest = '- main [ref=e1]:\n  - dialog [active] [ref=e2]:   \n  - generic [ref=e3]: Page'
  const dialog = '- dialog "Useful" [ref=e4]:\n  - button [ref=e5]'
  const tree = `${rest}\n${dialog}`
  expect(new BrowserSession({ maxSnapshotChars: tree.length - 1 }).shown(tree)).toBe(`${marker}\n${dialog}\nRest of the page:\n${rest}`)
})

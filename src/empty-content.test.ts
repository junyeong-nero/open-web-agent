import { expect, it } from "bun:test"
import { hasEmptyContent } from "./empty-content"

it("drops all four chrome subtrees, including YAML-quoted landmark keys", () => {
  const tree = ["navigation", "banner", "contentinfo", "complementary"].map((role) =>
    `- '${role} "Site: menu" [ref=e1]':\n  - heading "${"chrome".repeat(20)}"\n  - link "Home":\n    - /url: /home`,
  ).join("\n")
  expect(hasEmptyContent(`${tree}\n- main\n- heading "Best drives and road trips from"`)).toBe(true)
})

it("counts names, text and inline values, but not refs, states, URLs or placeholders", () => {
  expect(hasEmptyContent(`- button "${"x".repeat(59)}" [ref=e123] [disabled]`)).toBe(true)
  expect(hasEmptyContent(`- heading "${"x".repeat(60)}" [level=1]`)).toBe(false)
  expect(hasEmptyContent(`- textbox "Name" [ref=e1]:\n  - /placeholder: ${"x".repeat(80)}\n- link "Go":\n  - /url: https://example.test/${"x".repeat(80)}`)).toBe(true)
  expect(hasEmptyContent(`- heading "${"x".repeat(20)}"\n- text: ${"y".repeat(20)}\n- paragraph: ${"z".repeat(20)}`)).toBe(false)
})

it("handles YAML-quoted keys and escaped accessible names", () => {
  expect(hasEmptyContent(`- 'button "a: b" [ref=e1]'`)).toBe(true)
  expect(hasEmptyContent(`- 'button "a: b" [ref=e1]': ${"x".repeat(56)}`)).toBe(false)
  expect(hasEmptyContent(`- 'button "It''s ready: now" [ref=e1]'`)).toBe(true)
  expect(hasEmptyContent(`- button "say \\"hello\\""`)).toBe(true)
})

it("counts content outside an empty main landmark", () => {
  expect(hasEmptyContent(`- main\n- heading "Local guide"\n- paragraph: Explore the neighborhood on foot and discover its parks, cafes, and quiet streets.`)).toBe(false)
})

it("never flags missing, malformed or unrecognized trees", () => {
  for (const tree of ["", "  \n", "[]", "null", "not a tree", "- main: [", "- main:\n  unexpected: value", "- 123", "- unknown syntax!", "- main\n… [snapshot truncated at 10 chars]"]) {
    expect(hasEmptyContent(tree)).toBe(false)
  }
})

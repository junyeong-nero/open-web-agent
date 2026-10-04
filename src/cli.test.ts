import { expect, it } from "bun:test"
import { main } from "./cli"

it.each(["abc", "0", "-3", "1.5", "10abc", ""])("rejects --max-steps %p before resolving a model", async (value) => {
  await expect(main(["run", "task", `--max-steps=${value}`])).rejects.toThrow("--max-steps must be a positive integer")
})

it.each([["--max-steps", "5"], []])("accepts valid or omitted --max-steps %p", async (...flags) => {
  // No task, so main stops at the usage check that follows option validation.
  await expect(main(["run", ...flags])).rejects.toThrow('Usage: owa run "<task>"')
})

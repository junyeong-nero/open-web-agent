import { describe, expect, it } from "bun:test"

describe("core workspace package", () => {
  it("loads in the Bun workspace", async () => {
    const module = await import("./index")

    expect(module).toBeDefined()
  })
})

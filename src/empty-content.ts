/** Count visible snapshot text outside site chrome. Unknown tree shapes never count as empty. */
export function hasEmptyContent(tree: string): boolean {
  try {
    const parsed: unknown = Bun.YAML.parse(tree)
    if (!Array.isArray(parsed) || !parsed.length) return false
    const count = (nodes: unknown[]): number => nodes.reduce<number>((total, node) => {
      const entries: [string, unknown][] = typeof node === "string" ? [[node, null]]
        : node && typeof node === "object" && !Array.isArray(node) ? Object.entries(node) : []
      if (entries.length !== 1) throw new Error("Unknown snapshot node")
      const [key, value] = entries[0]
      if (key === "/url" || key === "/placeholder") return total
      const role = /^([a-z][a-z0-9-]*)(?: ("(?:\\.|[^"\\])*"))?(?: \[[^\]]*\])*$/.exec(key)
      if (!role) throw new Error("Unknown snapshot role")
      if (/^(navigation|banner|contentinfo|complementary)$/.test(role[1])) return total
      const name: string = role[2] ? JSON.parse(role[2]) : ""
      if (Array.isArray(value)) return total + name.length + count(value)
      if (value !== null && !["string", "number", "boolean"].includes(typeof value)) throw new Error("Unknown snapshot value")
      return total + name.length + (value === null ? 0 : String(value).length)
    }, 0)
    return count(parsed) < 60
  } catch {
    return false
  }
}

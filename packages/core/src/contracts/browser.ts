import { z } from "zod"

const SAFE_NAVIGATION_PROTOCOLS = new Set(["http:", "https:"])

export interface BrowserNavigationPolicyOptions {
  allowPrivateNetworkNavigation?: boolean
}

export const BrowserNavigationUrlSchema = z
  .string()
  .url()
  .refine(
    (value) => isAllowedBrowserNavigationUrl(value, { allowPrivateNetworkNavigation: true }),
    "Navigate URLs must use http(s)",
  )

export const BoundingBoxSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
})

export const ElementRefSchema = z.object({
  id: z.string(),
  role: z.string().nullable(),
  name: z.string().nullable(),
  text: z.string().nullable(),
  selector: z.string().nullable(),
  xpath: z.string().nullable(),
  boundingBox: BoundingBoxSchema.nullable(),
  attributes: z.record(z.string(), z.string()).default({}),
})

export const ActionTargetSchema = z.object({
  elementId: z.string().nullable().default(null),
  selector: z.string().nullable().default(null),
  text: z.string().nullable().default(null),
  role: z.string().nullable().default(null),
  name: z.string().nullable().default(null),
  coordinates: z
    .object({
      x: z.number(),
      y: z.number(),
    })
    .nullable()
    .default(null),
})

export const BrowserCapabilitySchema = z.enum([
  "core",
  "network",
  "storage",
  "testing",
  "vision",
  "pdf",
  "devtools",
  "config",
])

export const BrowserToolTypeSchema = z.enum([
  "navigate",
  "click",
  "type",
  "scroll",
  "wait",
  "press_key",
  "screenshot",
  "extract_text",
  "go_back",
  "go_forward",
])

export const BrowserToolParameterSchema = z.object({
  name: z.string(),
  type: z.string(),
  required: z.boolean(),
  description: z.string(),
})

export const NavigateArgumentsSchema = z.object({ url: BrowserNavigationUrlSchema }).strict()
export const ClickArgumentsSchema = z.object({ target: ActionTargetSchema }).strict()
export const TypeArgumentsSchema = z.object({ target: ActionTargetSchema, value: z.string() }).strict()
export const ScrollArgumentsSchema = z
  .object({
    deltaX: z.number().default(0),
    deltaY: z.number(),
  })
  .strict()
export const WaitArgumentsSchema = z.object({ ms: z.number().int().positive() }).strict()
export const PressKeyArgumentsSchema = z.object({ key: z.string().min(1) }).strict()
export const EmptyBrowserToolArgumentsSchema = z.object({}).strict()

export const BrowserToolDefinitionSchema = z.object({
  name: z.string().min(1),
  type: BrowserToolTypeSchema,
  capability: BrowserCapabilitySchema,
  description: z.string(),
  inputSchema: z.record(z.string(), z.unknown()),
  readOnly: z.boolean(),
  requiresApproval: z.boolean().default(false),
  parameters: z.array(BrowserToolParameterSchema),
  example: z.record(z.string(), z.unknown()),
})

const BrowserToolCallBaseSchema = z.object({ id: z.string().min(1) })

export const BrowserToolCallSchema = z.discriminatedUnion("type", [
  BrowserToolCallBaseSchema.extend({ type: z.literal("navigate"), ...NavigateArgumentsSchema.shape }).strict(),
  BrowserToolCallBaseSchema.extend({ type: z.literal("click"), ...ClickArgumentsSchema.shape }).strict(),
  BrowserToolCallBaseSchema.extend({ type: z.literal("type"), ...TypeArgumentsSchema.shape }).strict(),
  BrowserToolCallBaseSchema.extend({ type: z.literal("scroll"), ...ScrollArgumentsSchema.shape }).strict(),
  BrowserToolCallBaseSchema.extend({ type: z.literal("wait"), ...WaitArgumentsSchema.shape }).strict(),
  BrowserToolCallBaseSchema.extend({ type: z.literal("press_key"), ...PressKeyArgumentsSchema.shape }).strict(),
  BrowserToolCallBaseSchema.extend({ type: z.literal("screenshot") }).strict(),
  BrowserToolCallBaseSchema.extend({ type: z.literal("extract_text") }).strict(),
  BrowserToolCallBaseSchema.extend({ type: z.literal("go_back") }).strict(),
  BrowserToolCallBaseSchema.extend({ type: z.literal("go_forward") }).strict(),
])

export const BrowserActionSchema = z.object({
  id: z.string(),
  kind: z.string(),
  reason: z.string().nullable(),
  requiresApproval: z.boolean().default(false),
  toolCalls: z.array(BrowserToolCallSchema).min(1),
})

export const ObservationSchema = z.object({
  url: z.string(),
  title: z.string().nullable(),
  text: z.string().nullable(),
  screenshotPath: z.string().nullable(),
  interactiveElements: z.array(ElementRefSchema),
  metadata: z.record(z.string(), z.unknown()).default({}),
})

export const ActionResultSchema = z.object({
  ok: z.boolean(),
  message: z.string().nullable(),
  observation: ObservationSchema.nullable(),
  metadata: z.record(z.string(), z.unknown()).default({}),
})

export type BrowserToolCall = z.infer<typeof BrowserToolCallSchema>
export type BrowserCapability = z.infer<typeof BrowserCapabilitySchema>
export type BrowserToolType = z.infer<typeof BrowserToolTypeSchema>
export type BrowserToolParameter = z.infer<typeof BrowserToolParameterSchema>
export type BrowserToolDefinition = z.infer<typeof BrowserToolDefinitionSchema>
export type BrowserAction = z.infer<typeof BrowserActionSchema>
export type Observation = z.infer<typeof ObservationSchema>
export type ActionResult = z.infer<typeof ActionResultSchema>

export function isAllowedBrowserNavigationUrl(
  value: string,
  options: BrowserNavigationPolicyOptions = {},
): boolean {
  const url = parseUrl(value)
  if (!url) return false
  if (!SAFE_NAVIGATION_PROTOCOLS.has(url.protocol)) return false
  if (options.allowPrivateNetworkNavigation) return true

  const hostname = normalizeHostname(url.hostname)
  if (!hostname) return false
  if (isLocalHostname(hostname)) return false
  if (isPrivateIPv4(hostname)) return false
  if (isPrivateIPv6(hostname)) return false

  return true
}

function parseUrl(value: string): URL | null {
  try {
    return new URL(value)
  } catch {
    return null
  }
}

function normalizeHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/^\[/, "").replace(/\]$/, "").replace(/\.+$/, "")
}

function isLocalHostname(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname === "local" ||
    hostname.endsWith(".local") ||
    hostname === "internal" ||
    hostname.endsWith(".internal") ||
    (!hostname.includes(".") && !hostname.includes(":"))
  )
}

function isPrivateIPv4(hostname: string): boolean {
  const parts = hostname.split(".")
  if (parts.length !== 4) return false

  const octets = parts.map((part) => Number(part))
  if (octets.some((octet, index) => !isCanonicalIPv4Octet(octet, parts[index] ?? ""))) {
    return false
  }

  const [first, second] = octets as [number, number, number, number]
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 198 && (second === 18 || second === 19)) ||
    first >= 224
  )
}

function isCanonicalIPv4Octet(octet: number, raw: string): boolean {
  return Number.isInteger(octet) && octet >= 0 && octet <= 255 && String(octet) === raw
}

function isPrivateIPv6(hostname: string): boolean {
  if (!hostname.includes(":")) return false

  if (hostname === "::" || hostname === "::1") return true
  const firstGroup = Number.parseInt(hostname.split(":")[0] ?? "", 16)
  if (firstGroup >= 0xfc00 && firstGroup <= 0xfdff) return true
  if (firstGroup >= 0xfe80 && firstGroup <= 0xfebf) return true

  return isPrivateIPv4MappedIPv6(hostname)
}

function isPrivateIPv4MappedIPv6(hostname: string): boolean {
  if (!hostname.startsWith("::ffff:")) return false

  const mapped = hostname.slice("::ffff:".length)
  if (mapped.includes(".")) return isPrivateIPv4(mapped)

  const groups = mapped.split(":")
  if (groups.length !== 2) return false

  const high = Number.parseInt(groups[0] ?? "", 16)
  const low = Number.parseInt(groups[1] ?? "", 16)
  if (!isIPv6Hextet(high) || !isIPv6Hextet(low)) {
    return false
  }

  return isPrivateIPv4([high >> 8, high & 0xff, low >> 8, low & 0xff].join("."))
}

function isIPv6Hextet(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= 0xffff
}

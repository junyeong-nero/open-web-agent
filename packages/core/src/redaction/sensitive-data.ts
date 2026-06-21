export const REDACTED_VALUE = "[redacted]"

const SENSITIVE_FIELD_TOKENS = new Set([
  "authorization",
  "credential",
  "credentials",
  "otp",
  "pass",
  "password",
  "passwd",
  "pin",
  "pwd",
  "secret",
  "token",
])

export function redactSensitiveData<T>(value: T): T {
  return redactValue(value) as T
}

function redactValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactValue)
  if (!isRecord(value)) return value

  const isTypeToolCall = value.type === "type" && "value" in value
  const isSensitiveElement = isSensitiveElementRecord(value)
  const redacted: Record<string, unknown> = {}

  for (const [key, entry] of Object.entries(value)) {
    if (isTypeToolCall && key === "value") {
      redacted[key] = REDACTED_VALUE
      continue
    }

    if (isSensitiveElement && (key === "name" || key === "text") && isNonEmptyString(entry)) {
      redacted[key] = REDACTED_VALUE
      continue
    }

    if (key === "attributes" && isRecord(entry)) {
      redacted[key] = redactAttributes(entry, isSensitiveElement)
      continue
    }

    if (isSensitiveFieldName(key) && isScalar(entry)) {
      redacted[key] = REDACTED_VALUE
      continue
    }

    redacted[key] = redactValue(entry)
  }

  return redacted
}

function redactAttributes(attributes: Record<string, unknown>, isSensitiveElement: boolean): Record<string, unknown> {
  const redacted: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(attributes)) {
    if ((isSensitiveElement && key.toLowerCase() === "value" && isNonEmptyString(value)) || isSensitiveFieldName(key)) {
      redacted[key] = isScalar(value) ? REDACTED_VALUE : redactValue(value)
      continue
    }

    redacted[key] = redactValue(value)
  }

  return redacted
}

function isSensitiveElementRecord(value: Record<string, unknown>): boolean {
  const attributes = isRecord(value.attributes) ? value.attributes : {}
  const type = readString(attributes.type).toLowerCase()
  if (type === "password" || type === "hidden") return true

  return [
    readString(value.id),
    readString(value.selector),
    readString(attributes.autocomplete),
    readString(attributes.id),
    readString(attributes.name),
  ].some(isSensitiveFieldName)
}

function isSensitiveFieldName(value: string): boolean {
  const tokens = tokenizeFieldName(value)
  if (tokens.some((token) => SENSITIVE_FIELD_TOKENS.has(token))) return true
  if (tokens.includes("api") && tokens.includes("key")) return true
  if (tokens.includes("access") && tokens.includes("token")) return true
  if (tokens.includes("refresh") && tokens.includes("token")) return true
  return false
}

function tokenizeFieldName(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
}

function readString(value: unknown): string {
  return typeof value === "string" ? value : ""
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0
}

function isScalar(value: unknown): boolean {
  return value === null || ["boolean", "number", "string"].includes(typeof value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

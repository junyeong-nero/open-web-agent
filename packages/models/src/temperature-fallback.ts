import type { ModelRequest } from "@open-web-agent/core"
import { ModelProviderHttpError } from "./retry"

export function shouldRetryWithoutTemperature(request: ModelRequest, error: unknown): boolean {
  return hasTemperatureParameter(request) && isUnsupportedTemperatureError(error)
}

export function withoutTemperatureParameter(request: ModelRequest): ModelRequest {
  const { temperature: _temperature, extraBody, ...rest } = request
  if (!extraBody || !Object.hasOwn(extraBody, "temperature")) return rest

  const { temperature: _extraTemperature, ...nextExtraBody } = extraBody
  if (Object.keys(nextExtraBody).length === 0) return rest
  return { ...rest, extraBody: nextExtraBody }
}

function hasTemperatureParameter(request: ModelRequest): boolean {
  return request.temperature !== undefined || Boolean(request.extraBody && Object.hasOwn(request.extraBody, "temperature"))
}

function isUnsupportedTemperatureError(error: unknown): boolean {
  if (!(error instanceof ModelProviderHttpError) || error.status !== 400) return false

  const providerError = parseProviderError(error.body)
  if (providerError?.param === "temperature" && providerError.code === "unsupported_value") return true

  const body = error.body.toLowerCase()
  return body.includes("temperature") && body.includes("unsupported")
}

function parseProviderError(body: string): { param?: unknown; code?: unknown } | null {
  try {
    const parsed = JSON.parse(body) as unknown
    if (!isRecord(parsed) || !isRecord(parsed.error)) return null
    return parsed.error
  } catch {
    return null
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

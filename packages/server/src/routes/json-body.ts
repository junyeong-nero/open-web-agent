export interface JsonBodyResult {
  ok: true
  value: unknown
}

export interface JsonBodyError {
  ok: false
  status: 415
  error: "Expected application/json"
}

export async function readJsonBody(request: {
  header(name: string): string | undefined
  json(): Promise<unknown>
}): Promise<JsonBodyResult | JsonBodyError> {
  if (!isJsonContentType(request.header("content-type") ?? "")) {
    return { ok: false, status: 415, error: "Expected application/json" }
  }

  return { ok: true, value: await request.json().catch(() => null) }
}

function isJsonContentType(contentType: string): boolean {
  const mediaType = contentType.split(";", 1)[0]?.trim().toLowerCase()
  return (
    mediaType === "application/json" ||
    Boolean(mediaType?.startsWith("application/") && mediaType.endsWith("+json"))
  )
}

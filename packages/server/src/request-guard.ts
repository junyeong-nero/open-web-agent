const stateChangingMethods = new Set(["POST", "PUT", "PATCH", "DELETE"])

export interface RequestRejection {
  status: 403
  error: "Forbidden host" | "Forbidden origin"
}

export function rejectUntrustedLocalRequest(request: Request): RequestRejection | null {
  const requestUrl = new URL(request.url)
  if (!isAllowedLoopbackHost(requestUrl.hostname)) {
    return { status: 403, error: "Forbidden host" }
  }

  const hostHeader = request.headers.get("host")
  if (hostHeader && !isAllowedLoopbackHost(readHostnameFromHostHeader(hostHeader))) {
    return { status: 403, error: "Forbidden host" }
  }

  const origin = request.headers.get("origin")
  if (origin && stateChangingMethods.has(request.method.toUpperCase()) && !isSameOrigin(origin, requestUrl)) {
    return { status: 403, error: "Forbidden origin" }
  }

  return null
}

function isSameOrigin(origin: string, requestUrl: URL): boolean {
  try {
    return new URL(origin).origin === requestUrl.origin
  } catch {
    return false
  }
}

function readHostnameFromHostHeader(host: string): string {
  try {
    return new URL(`http://${host}`).hostname
  } catch {
    return ""
  }
}

function isAllowedLoopbackHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[/, "").replace(/\]$/, "").replace(/\.+$/, "")
  return normalized === "127.0.0.1" || normalized === "localhost" || normalized === "::1"
}

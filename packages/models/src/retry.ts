export interface RetryOptions {
  maxRetry?: number
  isRetryable?: (error: unknown) => boolean
}

export class ModelProviderHttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`Model provider returned HTTP ${status}: ${body}`)
    this.name = "ModelProviderHttpError"
  }
}

export async function retryModelCall<T>(
  operation: () => Promise<T>,
  { maxRetry = 0, isRetryable = isTransientModelProviderError }: RetryOptions = {},
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation()
    } catch (error) {
      if (attempt >= maxRetry || !isRetryable(error)) throw error
    }
  }
}

export function isTransientModelProviderError(error: unknown): boolean {
  if (error instanceof ModelProviderHttpError) {
    return error.status === 408 || error.status === 409 || error.status === 429 || error.status >= 500
  }
  return true
}

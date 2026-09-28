/** Stop waiting for an uncooperative model; browser operations also need awaited cleanup. */
export async function interruptible<T>(
  work: () => Promise<T>,
  signal: AbortSignal,
  cleanup?: (pending: Promise<T>) => Promise<void>,
): Promise<T> {
  signal.throwIfAborted()
  let onAbort!: () => void
  const cancelled = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason)
    signal.addEventListener("abort", onAbort, { once: true })
  })
  const pending = Promise.resolve().then(() => { signal.throwIfAborted(); return work() })
  try {
    return await Promise.race([pending, cancelled])
  } catch (error) {
    if (signal.aborted && cleanup) await cleanup(pending)
    throw error
  } finally { signal.removeEventListener("abort", onAbort) }
}

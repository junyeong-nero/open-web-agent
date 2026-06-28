export const Flock = {
  setGlobal(_input: { state: string }) {},
  async withLock<T>(_key: string, fn: () => T | Promise<T>): Promise<T> {
    return await fn()
  },
}

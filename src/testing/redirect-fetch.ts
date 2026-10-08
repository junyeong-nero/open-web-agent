/**
 * Preloaded into CLI processes by tests (`bun --preload`). Sends requests whose URL starts with OWA_TEST_FETCH_FROM to
 * OWA_TEST_FETCH_TO instead, so a model on a provider with a fixed URL, such as the judge's, can talk to a local fake.
 */
const from = process.env.OWA_TEST_FETCH_FROM
const to = process.env.OWA_TEST_FETCH_TO
if (from && to) {
  const real = globalThis.fetch
  globalThis.fetch = Object.assign(
    (input: string | URL | Request, init?: RequestInit) => real(typeof input === "string" && input.startsWith(from) ? to + input.slice(from.length) : input, init),
    real,
  )
}

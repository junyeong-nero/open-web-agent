const PAGES: Record<string, string> = {
  "/": `<!doctype html><html><head><title>Fixture Home</title></head><body>
    <h1>Fixture Home</h1>
    <label>Search <input id="q" /></label>
    <button id="go" onclick="document.querySelector('#out').textContent = 'Searched ' + document.querySelector('#q').value">Search</button>
    <select aria-label="Plan"><option value="free">Free</option><option value="pro">Pro</option></select>
    <p id="out">Idle</p>
    <a href="/pricing">Pricing</a>
    <a href="/pricing" target="_blank">Pricing in new tab</a>
  </body></html>`,
  "/sorry": `<!doctype html><title>Just a moment...</title><h1>Check you are human</h1>`,
  "/async": `<!doctype html><html><head><title>Async lookup</title></head><body>
    <h1>Async lookup</h1><button onclick="document.querySelector('#result').textContent='Loading'; setTimeout(() => document.querySelector('#result').textContent='READY-314', 1500)">Start lookup</button>
    <p id="result">Not started</p></body></html>`,
  "/pricing": `<!doctype html><html><head><title>Pricing</title></head><body>
    <h1>Pricing</h1><p>The Pro plan costs $42 per month.</p>
  </body></html>`,
}

export function startFixtureServer(): { url: string; stop(): void } {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url)
      if (url.pathname === "/redirect") return Response.redirect(new URL("/sorry?token=" + "x".repeat(400), url).href)
      const html = PAGES[url.pathname]
      return html
        ? new Response(html, { headers: { "content-type": "text/html" } })
        : new Response("not found", { status: 404 })
    },
  })
  return { url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) }
}

export function refFor(snapshot: string, pattern: RegExp): string {
  const line = snapshot.split("\n").find((candidate) => pattern.test(candidate))
  const ref = line?.match(/\[ref=([^\]]+)\]/)?.[1]
  if (!ref) throw new Error(`No ref matching ${pattern} in:\n${snapshot}`)
  return ref
}

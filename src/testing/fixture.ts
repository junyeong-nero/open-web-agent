/** Styled controls as many sites draw them: the real input sits under the element after it. */
const TOGGLES = `<title>Card options</title><style>
    .covered { position: relative; display: inline-block }
    .covered > input { position: absolute; left: 0; top: 0; margin: 0; opacity: 0 }
    .covered > :not(input) { position: relative; display: inline-block; padding-left: 20px }
  </style>
    <script>document.addEventListener("change", () => { document.documentElement.dataset.changedAt ??= String(Date.now()) })</script>
    <p><label class="covered" for="compare"><input id="compare" type="checkbox"><span>Add to compare</span></label></p>
    <p><span class="covered"><input id="express" type="radio" name="shipping"><label for="express">Express shipping</label></span>
      <label><input id="standard" type="radio" name="shipping" checked> Standard shipping</label></p>
    <p><span class="covered"><input id="gift" type="checkbox"><label for="insurance">Insurance</label></span>
      <input id="insurance" type="checkbox"> <label for="gift">Gift wrap</label></p>
    <p><label class="covered"><input id="terms" type="checkbox"><a href="/pricing">I accept the terms</a></label></p>
    <p><label><input id="updates" type="checkbox"> Email me card offers</label></p>
    <div style="height: 2000px"></div>`

/** Render a result list 800 ms after DOMContentLoaded. */
const LATE_LIST = `<script>
    setTimeout(() => document.body.insertAdjacentHTML("beforeend", "<h1>Search results</h1><ul><li>Result one</li><li>Result two</li></ul>"), 800)
  </script>`

const PAGES: Record<string, string> = {
  "/slow-render": `<!doctype html><title>Slow renderer</title><script>
    // Simulate a renderer blocked during its first text render, independently of network speed.
    const started = performance.now();
    while (performance.now() - started < 2500) {}
  </script><h1>Renderer ready</h1>`,
  "/": `<!doctype html><html><head><title>Fixture Home</title></head><body>
    <h1>Fixture Home</h1>
    <label>Search <input id="q" /></label>
    <button id="go" onclick="document.querySelector('#out').textContent = 'Searched ' + document.querySelector('#q').value">Search</button>
    <select aria-label="Plan"><option value="free">Free</option><option value="pro">Pro</option></select>
    <p id="out">Idle</p>
    <a href="/pricing">Pricing</a>
    <a href="/pricing" target="_blank">Pricing in new tab</a>
  </body></html>`,
  "/products": `<!doctype html><html><head><title>Airwrap listings</title></head><body>
    <h1>Dyson Airwrap listings</h1>
    <label>Sort by <select onchange="const list = document.querySelector('#products'); [...list.children].sort((a, b) => this.value === 'price' ? Number(a.dataset.price) - Number(b.dataset.price) : Number(a.dataset.rank) - Number(b.dataset.rank)).forEach(item => list.append(item))">
      <option value="recommended">Recommended</option><option value="price">Price: low to high</option>
    </select></label>
    <ol id="products">${Array.from({ length: 30 }, (_, index) => {
      const name = index === 0 ? "Dyson Airwrap Origin+" : index === 22 ? "Dyson Airwrap Origin Multi Styler and Dryer" : `Dyson Airwrap Complete Set ${index + 1}`
      const price = index === 0 ? 391320 : index === 22 ? 389430 : 415000 + index * 1730
      return `<li data-price="${price}" data-rank="${index}"><h2>${name}</h2>${index === 0 ? "<strong>Featured bestseller — recommended pick</strong>" : ""}<p>Price: ${price.toLocaleString("en-US")} KRW</p><p>New product, in stock. Includes styling attachments. Delivery included; no membership or coupon required.</p></li>`
    }).join("")}</ol>
  </body></html>`,
  "/article": `<!doctype html><html><head><title>Long article</title></head><body>
    <header>Site header</header>
    <main><h1>Long article</h1>${Array.from({ length: 8 }, (_, index) => `<h2>Table ${index + 1}</h2>${"<p>Measured values are listed in this table.</p>".repeat(250)}`).join("")}<p>End of article</p></main>
  </body></html>`,
  // Like many sites, open a modal in a portal at the end of a long page, past where its snapshot is cut.
  "/trade-in": `<!doctype html><html><head><title>Trade-in values</title></head><body>
    <h1>Trade in your device</h1>
    <button onclick="document.querySelector('#portal').append(document.querySelector('template').content.cloneNode(true)); document.querySelector('[role=dialog]').focus()">See all values</button>
    <ol>${Array.from({ length: 300 }, (_, index) => `<li><a href="#model-${index + 1}">Phone model ${index + 1}</a> <button>Estimate ${index + 1}</button></li>`).join("")}</ol>
    <div id="portal"></div>
    <template><div style="position: fixed; inset: 0; background: rgb(0 0 0 / 50%)">
      <div role="dialog" aria-modal="true" aria-labelledby="values" tabindex="-1" style="margin: 40px; padding: 20px; background: white">
        <h2 id="values">Trade-in values</h2>
        <table><tr><th>Model</th><th>Value</th></tr><tr><td>Phone 11 Pro Max</td><td>Up to $140</td></tr></table>
        <button onclick="document.querySelector('#portal').replaceChildren()">Close</button>
      </div>
    </div></template>
  </body></html>`,
  "/sorry": `<!doctype html><title>Just a moment...</title><h1>Check you are human</h1>`,
  "/overlay": `<!doctype html><title>Overlay</title>
    <button>Buy now</button><div id="overlay" style="position: fixed; inset: 0"></div>`,
  "/toggles": `<!doctype html>${TOGGLES}`,
  // Like americanexpress.com, replace window.eval, which breaks Playwright's page-world evaluate but not its actions.
  "/toggles-no-eval": `<!doctype html><script>window.eval = () => { throw new Error("eval is disabled") }</script>${TOGGLES}`,
  "/async": `<!doctype html><html><head><title>Async lookup</title></head><body>
    <h1>Async lookup</h1><button onclick="document.querySelector('#result').textContent='Loading'; setTimeout(() => document.querySelector('#result').textContent='READY-314', 1500)">Start lookup</button>
    <p id="result">Not started</p></body></html>`,
  "/pricing": `<!doctype html><html><head><title>Pricing</title></head><body>
    <h1>Pricing</h1><p>The Pro plan costs $42 per month.</p>
  </body></html>`,
  // Like client-rendered pages: the body is still empty at DOMContentLoaded.
  "/late-list": `<!doctype html><title>Late list</title><body>${LATE_LIST}</body>`,
  "/late-list-no-eval": `<!doctype html><title>Late list</title><body><script>window.eval = () => { throw new Error("eval is disabled") }</script>${LATE_LIST}</body>`,
  "/late-fetch": `<!doctype html><title>Late results</title><body><h1>Late results</h1>
    <button onclick="fetch('/late-data').then((response) => response.text()).then((text) => { document.querySelector('#results').textContent = text })">Search</button>
    <p id="results">No results yet</p></body>`,
  // Like Bing: its first page has no results, and 500 ms after load, once a request it sent has returned, the page adds
  // redirect parameters to the URL and renders the search box again.
  "/late-redirect": `<!doctype html><title>Late redirect</title><body><h1>Search</h1><form id="search"><input aria-label="Query" name="q"></form><script>
    addEventListener("load", () => fetch("/late-data?ms=500").then(() => {
      history.replaceState(null, "", location.pathname + "?rdr=1")
      document.querySelector("#search").innerHTML = '<input aria-label="Query" name="q">'
    }))
  </script></body>`,
  // Like the blank bot-check pages, without a title or text, that reload into the real page.
  "/interstitial": `<!doctype html><body><script>setTimeout(() => location.replace("/pricing"), 300)</script></body>`,
  // Like a new renderer's first render on macOS: nothing answers for 2.5 s after DOMContentLoaded.
  "/busy-start": `<!doctype html><title>Busy start</title><h1>Busy start</h1><script>
    addEventListener("DOMContentLoaded", () => setTimeout(() => {
      const started = performance.now()
      while (performance.now() - started < 2500) {}
    }))
  </script>`,
  "/never-settles": `<!doctype html><title>Live ticker</title><body><h1>Live ticker</h1><button>Refresh</button><p id="tick">0</p><script>
    let ticks = 0
    setInterval(() => { document.querySelector("#tick").textContent = String(++ticks) }, 100)
  </script></body>`,
  "/live-connections": `<!doctype html><title>Live connections</title><body><h1>Live connections</h1>
    <button onclick="navigator.sendBeacon('/slow-ack', 'saved'); document.querySelector('#status').textContent = 'Saved'">Save</button>
    <p id="status">Not saved</p><script>new EventSource("/stream")</script></body>`,
  // Like Wolfram|Alpha: the page sends its query over a WebSocket, whose answer comes in parts, and a second socket
  // pushes ticks that the page keeps without showing them.
  "/socket-results": `<!doctype html><title>Socket results</title><body><h1>Socket results</h1>
    <button disabled onclick="queries.send('6 times 7')">Compute</button><ul id="parts"></ul><script>
    const queries = new WebSocket("ws://" + location.host + "/socket")
    queries.onopen = () => { document.querySelector("button").disabled = false }
    queries.onmessage = (event) => document.querySelector("#parts").insertAdjacentHTML("beforeend", "<li>" + event.data + "</li>")
    new WebSocket("ws://" + location.host + "/ticker").onmessage = (event) => { window.lastTick = event.data }
  </script></body>`,
}

export function startFixtureServer(): { url: string; stop(): void } {
  const timers = new Set<ReturnType<typeof setTimeout>>()
  const later = (ms: number, response: () => Response) => new Promise<Response>((resolve) => {
    const timer = setTimeout(() => {
      timers.delete(timer)
      resolve(response())
    }, ms)
    timers.add(timer)
  })
  const after = (ms: number, run: () => void) => {
    const timer = setTimeout(() => {
      timers.delete(timer)
      run()
    }, ms)
    timers.add(timer)
  }
  const server = Bun.serve<{ ticker: boolean; ticks?: ReturnType<typeof setInterval> }>({
    hostname: "127.0.0.1",
    port: 0,
    websocket: {
      open(socket) {
        if (!socket.data.ticker) return
        socket.data.ticks = setInterval(() => socket.send(`tick ${Date.now()}`), 200)
        timers.add(socket.data.ticks)
      },
      // Answer a query in two parts, 800 ms apart.
      message(socket) {
        after(300, () => socket.send("Input interpretation: 6 times 7"))
        after(1_100, () => socket.send("Result: 42"))
      },
      close(socket) {
        if (socket.data.ticks) clearInterval(socket.data.ticks)
      },
    },
    fetch(request, server) {
      const url = new URL(request.url)
      if (url.pathname === "/socket" || url.pathname === "/ticker") {
        return server.upgrade(request, { data: { ticker: url.pathname === "/ticker" } }) ? undefined : new Response("upgrade failed", { status: 400 })
      }
      if (url.pathname === "/locale") return Response.json({ acceptLanguage: request.headers.get("accept-language") })
      if (url.pathname === "/slow-body") {
        let timer: ReturnType<typeof setTimeout>
        const body = new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('<!doctype html><title>Slow page</title><h1>Usable content</h1>'))
            timer = setTimeout(() => {
              timers.delete(timer)
              controller.enqueue(new TextEncoder().encode('<p>Finished loading</p>'))
              controller.close()
            }, 5_000)
            timers.add(timer)
          },
          cancel() {
            clearTimeout(timer)
            timers.delete(timer)
          },
        })
        return new Response(body, { headers: { "content-type": "text/html", "cache-control": "no-store" } })
      }
      if (url.pathname === "/late-data") return later(Number(url.searchParams.get("ms") ?? 800), () => new Response("Found 3 results", { headers: { "cache-control": "no-store" } }))
      if (url.pathname === "/slow-ack") return later(2_500, () => new Response(null, { status: 204 }))
      if (url.pathname === "/slow-page") return later(1_200, () => new Response("<!doctype html><title>Slow results</title><h1>Slow results</h1>", { headers: { "content-type": "text/html" } }))
      if (url.pathname === "/stream") {
        return new Response(new ReadableStream({ start: (controller) => controller.enqueue(new TextEncoder().encode(": open\n\n")) }), {
          headers: { "content-type": "text/event-stream", "cache-control": "no-store" },
        })
      }
      if (url.pathname === "/redirect") return Response.redirect(new URL("/sorry?token=" + "x".repeat(400), url).href)
      if (url.pathname === "/forbidden") return new Response("<!doctype html><title>Access denied</title><h1>Access denied</h1>", { status: 403, headers: { "content-type": "text/html" } })
      if (url.pathname === "/paper") return new Response("%PDF-1.4\n", { headers: { "content-type": "application/pdf", "content-disposition": 'attachment; filename="paper.pdf"' } })
      const html = PAGES[url.pathname]
      return html
        ? new Response(html, { headers: { "content-type": "text/html" } })
        : new Response("not found", { status: 404 })
    },
  })
  return { url: `http://127.0.0.1:${server.port}`, stop: () => {
    for (const timer of timers) clearTimeout(timer)
    server.stop(true)
  } }
}

export function refFor(snapshot: string, pattern: RegExp): string {
  const line = snapshot.split("\n").find((candidate) => pattern.test(candidate))
  const ref = line?.match(/\[ref=([^\]]+)\]/)?.[1]
  if (!ref) throw new Error(`No ref matching ${pattern} in:\n${snapshot}`)
  return ref
}

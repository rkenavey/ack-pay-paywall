/** Anything with a Fetch-API handler, such as a Hono app. */
export interface FetchHandler {
  fetch(request: Request): Response | Promise<Response>
}

/**
 * Turns an in-process app into a `fetch`, so a client can talk to the real
 * server without a network. Absolute URLs pass through unchanged; the app
 * routes on the path.
 */
export function inProcessFetch(app: FetchHandler): typeof fetch {
  return async (input, init) => app.fetch(new Request(input, init))
}

/** A request a {@link FetchStub} received. */
export interface RecordedRequest {
  method: string
  url: string
  path: string
  headers: Headers
  body: string
}

type StubHandler = (request: RecordedRequest, params: Record<string, string>) => Response | Promise<Response>

/**
 * A scripted `fetch` for client tests: routes by method and URL pattern
 * (`:name` segments become params) and records every request. An unrouted
 * request answers 599 so a test sees it.
 */
export class FetchStub {
  readonly requests: RecordedRequest[] = []
  readonly #routes: Array<{ method: string; pattern: RegExp; keys: string[]; handler: StubHandler }> = []

  /** Adds a route. `url` is absolute, such as `http://localhost:8787/api/resources/:id`; the query string is ignored. */
  on(method: string, url: string, handler: StubHandler): this {
    const keys: string[] = []
    const source = url
      .split("/")
      .map((part) => {
        if (part.startsWith(":")) {
          keys.push(part.slice(1))
          return "([^/?]+)"
        }
        return part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      })
      .join("/")
    this.#routes.push({ method: method.toUpperCase(), pattern: new RegExp(`^${source}(?:\\?.*)?$`), keys, handler })
    return this
  }

  /** The recorded requests matching a method and an exact path (no query string). */
  calls(method: string, path: string): RecordedRequest[] {
    return this.requests.filter((r) => r.method === method.toUpperCase() && r.path === path)
  }

  readonly fetch: typeof fetch = async (input, init) => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    const recorded: RecordedRequest = {
      method: request.method,
      url: request.url,
      path: url.pathname,
      headers: request.headers,
      body: request.body ? await request.text() : "",
    }
    this.requests.push(recorded)
    for (const route of this.#routes) {
      if (route.method !== recorded.method) continue
      const match = route.pattern.exec(request.url)
      if (!match) continue
      const params = Object.fromEntries(route.keys.map((key, i) => [key, decodeURIComponent(match[i + 1] ?? "")]))
      return route.handler(recorded, params)
    }
    return Response.json({ error: { code: "unrouted", message: `${recorded.method} ${recorded.url}` } }, { status: 599 })
  }
}

/** A JSON response. */
export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } })
}

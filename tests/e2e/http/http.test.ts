// The server on a real ephemeral port, reached with real fetch. The app is
// built from environment-style variables only: real clock, random ids,
// console log sink. Approval polling is short so the test stays quick.
import { serve, type ServerType } from "@hono/node-server"
import type { AddressInfo } from "node:net"
import { getDidResolver } from "agentcommercekit"
import * as v from "valibot"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createPaywallClient, createSandboxExecutor, defaultSelectOption, type PaywallClient } from "@paywall/client"
import { approvalListBodySchema, RECEIPT_HEADER, systemClock } from "@paywall/protocol"
import { buildApp, parseConfig } from "@paywall/server"
import { APPROVER_TOKEN, CLIENT_ORIGIN, fixtureEnv, fixtures, MemoryEventLog } from "@paywall/testkit"

let server: ServerType
let baseUrl = ""
let app: ReturnType<typeof buildApp> | undefined
const responses: Response[] = []

/** Real fetch that sends the browser's Origin header and keeps every response for the CORS checks. */
const browserFetch: typeof fetch = async (input, init) => {
  const headers = new Headers(init?.headers)
  headers.set("Origin", CLIENT_ORIGIN)
  const response = await fetch(input, { ...init, headers })
  responses.push(response)
  return response
}

beforeAll(async () => {
  server = await new Promise<ServerType>((resolve) => {
    const s = serve({ fetch: (request) => (app ? app.fetch(request) : new Response("starting", { status: 503 })), port: 0, hostname: "127.0.0.1" }, () => resolve(s))
  })
  const { port } = server.address() as AddressInfo
  baseUrl = `http://127.0.0.1:${port}`
  app = buildApp(parseConfig(fixtureEnv({ PORT: String(port), PUBLIC_BASE_URL: baseUrl, LOG_FORMAT: "json" })))
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

function newClient(): { client: PaywallClient; log: MemoryEventLog } {
  const log = new MemoryEventLog(systemClock)
  const client = createPaywallClient({
    fetch: browserFetch,
    identity: fixtures.client,
    executors: [createSandboxExecutor()],
    selectOption: defaultSelectOption,
    resolver: getDidResolver(),
    clock: systemClock,
    log,
    approvalPoll: { intervalMs: 25, timeoutMs: 10_000 },
  })
  return { client, log }
}

describe("over real HTTP", () => {
  it("E2E-7: a preflight from the client origin is granted, with the Payment-Receipt header", async () => {
    const preflight = await fetch(`${baseUrl}/api/resources/market-brief`, {
      method: "OPTIONS",
      headers: { Origin: CLIENT_ORIGIN, "Access-Control-Request-Method": "GET", "Access-Control-Request-Headers": "payment-receipt" },
    })
    expect(preflight.headers.get("access-control-allow-origin")).toBe(CLIENT_ORIGIN)
    expect((preflight.headers.get("access-control-allow-headers") ?? "").toLowerCase()).toContain(RECEIPT_HEADER.toLowerCase())
  })

  it("E2E-7: E2E-1 over HTTP: market-brief over sandbox ends in 200, with CORS on every response", async () => {
    responses.length = 0
    const { client, log } = newClient()
    const state = await client.fetchPaid(`${baseUrl}/api/resources/market-brief`)
    expect(state.status, JSON.stringify(state.failure)).toBe("delivered")
    expect(state.resource?.id).toBe("market-brief")
    expect(log.names().at(-1)).toBe("client.resource.received")
    expect(responses.length).toBeGreaterThanOrEqual(6)
    for (const response of responses) expect(response.headers.get("access-control-allow-origin")).toBe(CLIENT_ORIGIN)
  })

  it("E2E-7: E2E-5 over HTTP: annual-report waits for the approver, is approved and delivered", async () => {
    const { client } = newClient()
    const run = client.fetchPaid(`${baseUrl}/api/resources/annual-report`)
    await new Promise<void>((resolve) => {
      const unsubscribe = client.subscribe((s) => {
        if (s.status === "awaiting_approval") {
          unsubscribe()
          resolve()
        }
      })
    })
    const headers = { Authorization: `Bearer ${APPROVER_TOKEN}` }
    const { approvals } = v.parse(approvalListBodySchema, await (await fetch(`${baseUrl}/payment-service/approvals?status=pending`, { headers })).json())
    expect(approvals).toHaveLength(1)
    const decided = await fetch(`${baseUrl}/payment-service/approvals/${approvals[0]?.approvalId}/decision`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ decision: "approve" }),
    })
    expect(decided.status).toBe(200)
    const state = await run
    expect(state.status, JSON.stringify(state.failure)).toBe("delivered")
    expect(state.resource?.id).toBe("annual-report")
  })
})

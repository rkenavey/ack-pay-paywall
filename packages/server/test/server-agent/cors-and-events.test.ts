import { afterEach, describe, expect, it, vi } from "vitest"
import { RECEIPT_HEADER } from "@paywall/protocol"
import { CLIENT_ORIGIN, eventStrings, fixtureEnv, JWT_PATTERN, MemoryEventLog, SequenceIds, useFixedTime } from "@paywall/testkit"
import { buildApp, parseConfig } from "../../src/index.ts"
import { setupServerAgent } from "./harness.ts"

afterEach(() => {
  vi.useRealTimers()
})

function preflight(path: string, origin: string, headers: string) {
  return {
    method: "OPTIONS",
    headers: { Origin: origin, "Access-Control-Request-Method": path.includes("payments") ? "POST" : "GET", "Access-Control-Request-Headers": headers },
  }
}

describe("CORS", () => {
  it("SA-13: a preflight from CLIENT_ORIGIN allows the Payment-Receipt header", async () => {
    const clock = useFixedTime()
    const app = buildApp(parseConfig(fixtureEnv()), { clock, ids: new SequenceIds(), log: new MemoryEventLog(clock) })
    for (const prefix of ["/api", "/partner"]) {
      const response = await app.request(`${prefix}/resources/market-brief`, preflight(`${prefix}/resources`, CLIENT_ORIGIN, "payment-receipt"))
      expect(response.status).toBeLessThan(300)
      expect(response.headers.get("access-control-allow-origin")).toBe(CLIENT_ORIGIN)
      const allowed = (response.headers.get("access-control-allow-headers") ?? "").toLowerCase().split(/\s*,\s*/)
      expect(allowed).toContain(RECEIPT_HEADER.toLowerCase())
    }
  })

  it("SA-13: the payment service allows Content-Type and Authorization from CLIENT_ORIGIN", async () => {
    const clock = useFixedTime()
    const app = buildApp(parseConfig(fixtureEnv()), { clock, ids: new SequenceIds(), log: new MemoryEventLog(clock) })
    const response = await app.request("/payment-service/payments", preflight("/payments", CLIENT_ORIGIN, "content-type,authorization"))
    expect(response.headers.get("access-control-allow-origin")).toBe(CLIENT_ORIGIN)
    const allowed = (response.headers.get("access-control-allow-headers") ?? "").toLowerCase().split(/\s*,\s*/)
    expect(allowed).toEqual(expect.arrayContaining(["content-type", "authorization"]))
  })

  it("SA-13: another origin gets no CORS grant", async () => {
    const clock = useFixedTime()
    const app = buildApp(parseConfig(fixtureEnv()), { clock, ids: new SequenceIds(), log: new MemoryEventLog(clock) })
    for (const path of ["/api/resources/market-brief", "/payment-service/payments"]) {
      const response = await app.request(path, preflight(path, "https://evil.example", "payment-receipt,content-type"))
      const granted = response.headers.get("access-control-allow-origin")
      expect(granted === null || granted === CLIENT_ORIGIN).toBe(true)
      expect(granted).not.toBe("*")
      expect(granted).not.toBe("https://evil.example")
    }
    const simple = await app.request("/api/resources", { headers: { Origin: "https://evil.example" } })
    expect(simple.status).toBe(200)
    expect(simple.headers.get("access-control-allow-origin")).not.toBe("https://evil.example")
    expect(simple.headers.get("access-control-allow-origin")).not.toBe("*")
  })
})

describe("server agent events", () => {
  it("SA-14: the happy path emits the server events in order", async () => {
    const { get, paymentRequired, receiptFor, log } = setupServerAgent()
    const body = await paymentRequired()
    const receipt = await receiptFor(body)
    expect((await get("market-brief", receipt)).status).toBe(200)

    expect(log.names()).toEqual([
      "server.request.received",
      "server.payment_required.issued",
      "server.request.received",
      "server.receipt.presented",
      "server.receipt.verified",
      "server.resource.delivered",
    ])
    for (const event of log.events) expect(event.actor).toBe("server-agent")
    const issued = log.one("server.payment_required.issued")
    expect(issued.paymentRequestId).toBe(body.paymentRequest.id)
    expect(log.one("server.resource.delivered").paymentRequestId).toBe(body.paymentRequest.id)
  })

  it("SA-14: events are stamped by the injected clock", async () => {
    const { paymentRequired, log, clock } = setupServerAgent()
    clock.advanceSeconds(42)
    await paymentRequired()
    for (const event of log.events) expect(event.at).toBe("2026-11-10T14:02:42.000Z")
  })

  it("SA-14: a rejection emits server.receipt.rejected with the code, then issues a fresh request", async () => {
    const { get, paymentRequired, receiptFor, log } = setupServerAgent()
    const body = await paymentRequired()
    const receipt = await receiptFor(body)
    await get("market-brief", receipt)
    log.clear()
    expect((await get("market-brief", receipt)).status).toBe(402)

    expect(log.names()).toEqual([
      "server.request.received",
      "server.receipt.presented",
      "server.receipt.rejected",
      "server.payment_required.issued",
    ])
    expect(log.one("server.receipt.rejected").data?.code).toBe("receipt_already_redeemed")
    expect(log.names()).not.toContain("server.resource.delivered")
  })

  it("SA-14: no event contains a complete JWT", async () => {
    const { get, paymentRequired, receiptFor, log } = setupServerAgent()
    const body = await paymentRequired()
    const receipt = await receiptFor(body)
    await get("market-brief", receipt)
    await get("market-brief", receipt)
    await get("market-brief", "not-a-jwt")

    const serialized = JSON.stringify(log.events)
    expect(serialized).not.toContain(receipt)
    expect(serialized).not.toContain(body.paymentRequestToken)
    for (const value of eventStrings(log.events)) expect(value).not.toMatch(JWT_PATTERN)
  })
})

import { getDidResolver, verifyPaymentReceipt } from "agentcommercekit"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createSandboxExecutor } from "@paywall/client"
import { APPROVER_TOKEN, elapse, fixtures } from "@paywall/testkit"
import { fakeStripeExecutor, reach, resourceUrl, setupSystem } from "../support.ts"

afterEach(() => {
  vi.useRealTimers()
})

describe("end to end over Stripe with the fake gateway", () => {
  it("E2E-4: market-brief over Stripe: the PaymentIntent succeeds, the receipt is issued, 200", async () => {
    const { client, log, gateway } = setupSystem({
      stripe: true,
      executors: (g) => [createSandboxExecutor(), fakeStripeExecutor(g)],
    })
    const state = await client.fetchPaid(resourceUrl("/api/resources/market-brief"))
    expect(state.status, JSON.stringify(state.failure)).toBe("delivered")
    expect(state.selectedOption?.id).toBe("stripe-usd")
    expect(state.resource?.id).toBe("market-brief")

    expect(gateway.createCalls).toHaveLength(1)
    expect(gateway.createCalls[0]).toMatchObject({ amount: 500, idempotencyKey: `pi:${state.payment?.paymentId}` })
    const [intent] = gateway.intents
    expect(intent?.status).toBe("succeeded")

    const { receipt } = await verifyPaymentReceipt(state.receipt as string, {
      resolver: getDidResolver(),
      trustedReceiptIssuers: [fixtures.paymentService.did],
      paymentRequestIssuer: fixtures.acme.did,
    })
    expect(receipt.credentialSubject.metadata).toMatchObject({ network: "stripe", settlementRef: intent?.id })
    expect(log.names()).toContain("ps.settlement.confirmed")
    expect(log.names().at(-1)).toBe("client.resource.received")
  })

  it("STR-5: an approved Stripe payment whose PaymentIntent could not be created fails for the waiting client, and nothing is delivered", async () => {
    const { client, fetch, log, gateway, clock } = setupSystem({
      stripe: true,
      fakeTimers: true,
      executors: (g) => [createSandboxExecutor(), fakeStripeExecutor(g)],
    })
    vi.spyOn(gateway, "createPaymentIntent").mockRejectedValueOnce(new Error("Stripe is unavailable"))
    gateway.failCancels(1)
    const run = client.fetchPaid(resourceUrl("/api/resources/annual-report"))
    const waiting = await reach(client, "awaiting_approval")
    const approvalId = waiting.payment?.approvalId as string
    const decided = await fetch(resourceUrl(`/payment-service/approvals/${approvalId}/decision`), {
      method: "POST",
      headers: { Authorization: `Bearer ${APPROVER_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ decision: "approve" }),
    })
    expect(decided.status).toBe(200)
    await elapse(clock, 1000)
    const state = await run
    expect(state.status).toBe("failed")
    expect(state.failure?.code).toBe("payment_failed")
    expect(state.payment?.status).toBe("failed")
    expect(state.resource).toBeUndefined()
    expect(log.names()).not.toContain("ps.settlement.started")
    expect(log.names()).not.toContain("server.resource.delivered")
    expect(log.all("ps.settlement.failed").map((event) => event.data?.reason)).toEqual(["failed", "cancel_failed"])
  })
})

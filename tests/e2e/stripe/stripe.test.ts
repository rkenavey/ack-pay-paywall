import { getDidResolver, verifyPaymentReceipt } from "agentcommercekit"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createSandboxExecutor } from "@paywall/client"
import { fixtures } from "@paywall/testkit"
import { fakeStripeExecutor, resourceUrl, setupSystem } from "../support.ts"

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
})

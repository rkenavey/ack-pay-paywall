import { getDidResolver, verifyPaymentReceipt } from "agentcommercekit"
import * as v from "valibot"
import { afterEach, describe, expect, it, vi } from "vitest"
import { receiptBodySchema } from "@paywall/protocol"
import { FAKE_STRIPE_KEYS, fixtures } from "@paywall/testkit"
import { expectError, expectView, setupPaymentService, usd } from "../payment-service/harness.ts"

afterEach(() => {
  vi.useRealTimers()
})

async function startStripePayment(ps: ReturnType<typeof setupPaymentService>, amount = 500) {
  const { paymentRequestToken } = await ps.request({ amount })
  const view = await expectView(await ps.initiate(paymentRequestToken, "stripe-usd"), 201)
  const intentId = ps.gateway.intents[0]?.id
  if (!intentId) throw new Error("no PaymentIntent was created")
  return { paymentRequestToken, view, intentId }
}

describe("Stripe adapter", () => {
  it("STR-1: initiating the Stripe option creates one PaymentIntent from the token, with metadata and idempotency key", async () => {
    const ps = setupPaymentService({ stripe: true })
    const { view, paymentRequestToken } = await startStripePayment(ps, 500)

    expect(ps.gateway.createCalls).toHaveLength(1)
    const call = ps.gateway.createCalls[0]
    expect(call).toMatchObject({
      amount: 500,
      currency: expect.stringMatching(/^usd$/i),
      metadata: { paymentId: view.paymentId, paymentRequestId: "pr_0001", paymentOptionId: "stripe-usd", payer: fixtures.client.did },
      idempotencyKey: `pi:${view.paymentId}`,
    })
    expect(view.network).toBe("stripe")
    expect(view.amount).toEqual(usd(500))
    expect(view.next).toEqual({
      type: "stripe_payment_element",
      clientSecret: `${ps.gateway.intents[0]?.id}_secret_fixture1`,
      publishableKey: FAKE_STRIPE_KEYS.publishableKey,
    })

    // Repeating the initiation creates no second PaymentIntent.
    await expectView(await ps.initiate(paymentRequestToken, "stripe-usd"), 200)
    expect(ps.gateway.createCalls).toHaveLength(1)
  })

  it("STR-2: with the PaymentIntent succeeded and matching, the receipt route issues a receipt whose settlementRef is the PaymentIntent id", async () => {
    const ps = setupPaymentService({ stripe: true })
    const { view, intentId } = await startStripePayment(ps)
    ps.gateway.succeed(intentId)

    const response = await ps.receipt(view.paymentId)
    expect(response.status).toBe(200)
    const { receipt } = v.parse(receiptBodySchema, await response.json())
    const verified = await verifyPaymentReceipt(receipt, {
      resolver: getDidResolver(),
      trustedReceiptIssuers: [fixtures.paymentService.did],
      paymentRequestIssuer: fixtures.acme.did,
    })
    expect(verified.receipt.credentialSubject.paymentOptionId).toBe("stripe-usd")
    expect(verified.receipt.credentialSubject.metadata).toMatchObject({ settlementRef: intentId, network: "stripe", amount: 500 })
    expect((await expectView(await ps.getPayment(view.paymentId), 200)).status).toBe("settled")
  })

  for (const status of ["requires_payment_method", "requires_confirmation", "requires_action", "processing"]) {
    it(`STR-3: with the PaymentIntent in ${status}, the receipt route answers 409 payment_not_settled`, async () => {
      const ps = setupPaymentService({ stripe: true })
      const { view, intentId } = await startStripePayment(ps)
      ps.gateway.update(intentId, { status })
      await expectError(await ps.receipt(view.paymentId), 409, "payment_not_settled")
      expect((await expectView(await ps.getPayment(view.paymentId), 200)).status).toBe("requires_payment")
      expect(ps.log.names()).not.toContain("ps.receipt.issued")
    })
  }

  const mismatches: Array<[string, Record<string, unknown>]> = [
    ["a different amount", { amount: 400, amountReceived: 400 }],
    ["less received than charged", { amountReceived: 499 }],
    ["a different currency", { currency: "eur" }],
    ["a different metadata.paymentId", { metadata: { paymentId: "pay_someone_else" } }],
  ]
  for (const [label, patch] of mismatches) {
    it(`STR-4: a succeeded PaymentIntent with ${label} answers 409 settlement_mismatch and issues nothing`, async () => {
      const ps = setupPaymentService({ stripe: true })
      const { view, intentId } = await startStripePayment(ps)
      ps.gateway.succeed(intentId)
      ps.gateway.update(intentId, patch)
      await expectError(await ps.receipt(view.paymentId), 409, "settlement_mismatch")
      expect(ps.log.names()).not.toContain("ps.receipt.issued")
      expect((await expectView(await ps.getPayment(view.paymentId), 200)).status).not.toBe("settled")
    })
  }

  it("STR-4: the sandbox settle route refuses a Stripe payment", async () => {
    const ps = setupPaymentService({ stripe: true })
    const { view } = await startStripePayment(ps)
    await expectError(await ps.settle(view.paymentId), 409, "payment_not_payable")
  })
})

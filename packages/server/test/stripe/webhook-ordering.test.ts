import { afterEach, describe, expect, it, vi } from "vitest"
import { expectError, expectView, setupPaymentService } from "../payment-service/harness.ts"

afterEach(() => {
  vi.useRealTimers()
})

async function stripePayment(ps: ReturnType<typeof setupPaymentService>) {
  const { paymentRequestToken } = await ps.request()
  const view = await expectView(await ps.initiate(paymentRequestToken, "stripe-usd"), 201)
  return { view, intentId: ps.gateway.intents[0]?.id as string }
}

function webhook(ps: ReturnType<typeof setupPaymentService>, body: string) {
  return ps.app.request("/webhooks/stripe", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Stripe-Signature": ps.gateway.signWebhook(body) },
    body,
  })
}

describe("Stripe settlement edge cases", () => {
  it("a payment_failed event that arrives after the PaymentIntent succeeded does not fail the payment", async () => {
    const ps = setupPaymentService({ stripe: true })
    const { view, intentId } = await stripePayment(ps)
    ps.gateway.succeed(intentId)
    expect((await webhook(ps, ps.gateway.webhookBody("payment_intent.payment_failed", intentId, "evt_late"))).status).toBe(200)
    expect((await expectView(await ps.getPayment(view.paymentId), 200)).status).toBe("requires_payment")
    expect((await ps.receipt(view.paymentId)).status).toBe(200)
  })

  it("a canceled PaymentIntent fails the payment when the receipt is asked for", async () => {
    const ps = setupPaymentService({ stripe: true })
    const { view, intentId } = await stripePayment(ps)
    ps.gateway.update(intentId, { status: "canceled" })
    await expectError(await ps.receipt(view.paymentId), 409, "payment_not_settled")
    expect((await expectView(await ps.getPayment(view.paymentId), 200)).status).toBe("failed")
  })

  it("the settlement time is fixed when the PaymentIntent is first seen succeeded", async () => {
    const ps = setupPaymentService({ stripe: true })
    const { view, intentId } = await stripePayment(ps)
    ps.gateway.succeed(intentId)
    const body = ps.gateway.webhookBody("payment_intent.succeeded", intentId, "evt_settle")
    expect((await webhook(ps, body)).status).toBe(200)
    const confirmed = ps.log.all("ps.settlement.confirmed")
    expect(confirmed).toHaveLength(1)
    expect(confirmed[0]?.data?.settledAt).toBe(ps.clock.now().toISOString())
    expect((await ps.receipt(view.paymentId)).status).toBe(200)
  })
})

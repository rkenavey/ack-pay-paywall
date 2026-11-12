import { afterEach, describe, expect, it, vi } from "vitest"
import { APPROVER_TOKEN, FakeStripeGateway } from "@paywall/testkit"
import { expectError, expectView, setupPaymentService } from "../payment-service/harness.ts"

afterEach(() => {
  vi.useRealTimers()
})

function webhook(ps: ReturnType<typeof setupPaymentService>, body: string) {
  return ps.app.request("/webhooks/stripe", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Stripe-Signature": ps.gateway.signWebhook(body) },
    body,
  })
}

async function expiringStripePayment(ps: ReturnType<typeof setupPaymentService>) {
  const { paymentRequestToken } = await ps.request({ expiresInMs: 60_000 })
  const view = await expectView(await ps.initiate(paymentRequestToken, "stripe-usd"), 201)
  return { view, intentId: ps.gateway.intents[0]?.id as string }
}

describe("cancelling the PaymentIntent of a failed Stripe payment", () => {
  it("a PaymentIntent that succeeded before the expiry was noticed is settled, not cancelled", async () => {
    const ps = setupPaymentService({ stripe: true })
    const { view, intentId } = await expiringStripePayment(ps)
    ps.gateway.succeed(intentId)
    ps.clock.advanceSeconds(61)
    expect((await ps.receipt(view.paymentId)).status).toBe(200)
    expect(ps.gateway.cancelCalls).toEqual([])
  })

  it("a PaymentIntent that succeeds while the cancel is in flight settles the payment instead of failing it", async () => {
    const ps = setupPaymentService({ stripe: true })
    const { view, intentId } = await expiringStripePayment(ps)
    ps.clock.advanceSeconds(61)
    const cancel = vi.spyOn(ps.gateway, "cancelPaymentIntent").mockImplementationOnce(async (id) => {
      ps.gateway.succeed(id)
      throw new Error("You cannot cancel this PaymentIntent because it has a status of succeeded.")
    })
    await expectError(await ps.receipt(view.paymentId), 409, "payment_not_settled")
    expect(cancel).toHaveBeenCalledWith(intentId)
    expect((await expectView(await ps.getPayment(view.paymentId), 200)).status).toBe("settled")
    expect((await ps.receipt(view.paymentId)).status).toBe(200)
  })

  it("a cancel error still fails the payment, and money that arrives afterwards issues no receipt and is logged", async () => {
    const ps = setupPaymentService({ stripe: true })
    const { view, intentId } = await expiringStripePayment(ps)
    ps.clock.advanceSeconds(61)
    ps.gateway.failCancels(1)
    await expectError(await ps.receipt(view.paymentId), 409, "payment_not_settled")
    const failed = await expectView(await ps.getPayment(view.paymentId), 200)
    expect(failed.status).toBe("failed")
    expect(failed.next).toBeUndefined()
    expect(ps.gateway.cancelCalls).toEqual([intentId])
    expect(ps.log.one("ps.settlement.failed").data).toMatchObject({ reason: "expired", cancel: "failed" })

    // The payer had the client secret and paid anyway.
    ps.gateway.succeed(intentId)
    expect((await webhook(ps, ps.gateway.webhookBody("payment_intent.succeeded", intentId, "evt_late_success"))).status).toBe(200)
    expect((await expectView(await ps.getPayment(view.paymentId), 200)).status).toBe("failed")
    await expectError(await ps.receipt(view.paymentId), 409, "payment_not_settled")
    expect(ps.log.all("ps.settlement.failed").map((event) => event.data?.reason)).toEqual(["expired", "succeeded_after_failure"])
    expect(ps.log.all("ps.settlement.confirmed")).toHaveLength(0)
  })

  it("when creating the PaymentIntent throws after Stripe created it, the payment fails and that PaymentIntent is cancelled", async () => {
    const ps = setupPaymentService({ stripe: true })
    vi.spyOn(ps.gateway, "createPaymentIntent").mockImplementationOnce(async (input) => {
      await FakeStripeGateway.prototype.createPaymentIntent.call(ps.gateway, input)
      throw new Error("the connection to Stripe timed out")
    })
    const { paymentRequestToken } = await ps.request()
    await expectError(await ps.initiate(paymentRequestToken, "stripe-usd"), 500, "internal_error")
    const [intent] = ps.gateway.intents
    expect(ps.gateway.intents).toHaveLength(1)
    expect(ps.gateway.cancelCalls).toEqual([intent?.id])
    expect(intent?.status).toBe("canceled")
    // The replay used the same idempotency key, so no second PaymentIntent exists.
    expect(ps.gateway.createCalls.map((call) => call.idempotencyKey)).toEqual(["pi:pay_0001", "pi:pay_0001"])
    expect(ps.log.one("ps.settlement.failed").data).toMatchObject({ network: "stripe" })
  })

  it("a Stripe payment that expires while waiting for a human fails without a PaymentIntent to cancel", async () => {
    const ps = setupPaymentService({ stripe: true })
    const { paymentRequestToken } = await ps.request({ amount: 7500, expiresInMs: 60_000 })
    const view = await expectView(await ps.initiate(paymentRequestToken, "stripe-usd"), 202)
    ps.clock.advanceSeconds(61)
    const decision = await ps.post(`/approvals/${view.approvalId as string}/decision`, { decision: "approve" }, { Authorization: `Bearer ${APPROVER_TOKEN}` })
    await expectError(decision, 410, "payment_request_expired")
    expect((await expectView(await ps.getPayment(view.paymentId), 200)).status).toBe("failed")
    expect(ps.gateway.createCalls).toHaveLength(0)
    expect(ps.gateway.cancelCalls).toEqual([])
  })

  it("an approved Stripe payment that later expires unpaid has its PaymentIntent cancelled", async () => {
    const ps = setupPaymentService({ stripe: true })
    const { paymentRequestToken } = await ps.request({ amount: 7500, expiresInMs: 60_000 })
    const view = await expectView(await ps.initiate(paymentRequestToken, "stripe-usd"), 202)
    const decision = await ps.post(`/approvals/${view.approvalId as string}/decision`, { decision: "approve" }, { Authorization: `Bearer ${APPROVER_TOKEN}` })
    expect(decision.status).toBe(200)
    const intentId = ps.gateway.intents[0]?.id as string
    ps.clock.advanceSeconds(61)
    await expectError(await ps.receipt(view.paymentId), 409, "payment_not_settled")
    expect((await expectView(await ps.getPayment(view.paymentId), 200)).status).toBe("failed")
    expect(ps.gateway.cancelCalls).toEqual([intentId])
  })
})

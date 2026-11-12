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

  // spec-fix(T7): STR-5 was amended; a PaymentIntent that succeeded wins over expiry and the receipt is issued, so the receipt route that noticed it now answers 200 rather than 409
  it("a PaymentIntent that succeeds while the cancel is in flight settles the payment instead of failing it", async () => {
    const ps = setupPaymentService({ stripe: true })
    const { view, intentId } = await expiringStripePayment(ps)
    ps.clock.advanceSeconds(61)
    const cancel = vi.spyOn(ps.gateway, "cancelPaymentIntent").mockImplementationOnce(async (id) => {
      ps.gateway.succeed(id)
      throw new Error("You cannot cancel this PaymentIntent because it has a status of succeeded.")
    })
    expect((await ps.receipt(view.paymentId)).status).toBe(200)
    expect(cancel).toHaveBeenCalledWith(intentId)
    expect((await expectView(await ps.getPayment(view.paymentId), 200)).status).toBe("settled")
    expect((await ps.receipt(view.paymentId)).status).toBe(200)
    expect(ps.log.all("ps.settlement.failed")).toHaveLength(0)
  })

  // spec-fix(T7): STR-5 was amended; a payment whose cancel fails now stays in requires_payment and the cancel is retried, instead of failing anyway with cancel=failed
  it("STR-5: when the cancel fails the payment stays in requires_payment, and the next touch retries the cancel and then fails it", async () => {
    const ps = setupPaymentService({ stripe: true })
    const { view, intentId } = await expiringStripePayment(ps)
    ps.clock.advanceSeconds(61)
    ps.gateway.failCancels(1)
    await expectError(await ps.receipt(view.paymentId), 409, "payment_not_settled")
    const waiting = await expectView(await ps.getPayment(view.paymentId), 200)
    expect(waiting.status).toBe("requires_payment")
    expect(waiting.next).toEqual(view.next)
    expect(ps.gateway.cancelCalls).toEqual([intentId])
    expect(ps.gateway.intents[0]?.status).toBe("requires_payment_method")
    expect(ps.log.one("ps.settlement.failed").data).toMatchObject({ network: "stripe", reason: "cancel_failed", cause: "expired" })

    // Reading the payment is not a touch.
    await expectView(await ps.getPayment(view.paymentId), 200)
    expect(ps.gateway.cancelCalls).toEqual([intentId])

    // The next touch retries the cancel once; Stripe confirms it and only then does the payment fail.
    await expectError(await ps.receipt(view.paymentId), 409, "payment_not_settled")
    const failed = await expectView(await ps.getPayment(view.paymentId), 200)
    expect(failed.status).toBe("failed")
    expect(failed.next).toBeUndefined()
    expect(ps.gateway.cancelCalls).toEqual([intentId, intentId])
    expect(ps.gateway.intents[0]?.status).toBe("canceled")
    expect(ps.log.all("ps.settlement.failed").map((event) => event.data?.reason)).toEqual(["cancel_failed", "expired"])

    // Once failed, nothing is retried.
    await expectError(await ps.receipt(view.paymentId), 409, "payment_not_settled")
    expect(ps.gateway.cancelCalls).toEqual([intentId, intentId])
    expect(ps.log.all("ps.settlement.failed")).toHaveLength(2)
  })

  it("STR-5: each touch tries the outstanding cancel exactly once while Stripe keeps refusing it", async () => {
    const ps = setupPaymentService({ stripe: true })
    const { view, intentId } = await expiringStripePayment(ps)
    ps.clock.advanceSeconds(61)
    ps.gateway.failCancels(3)
    for (let touch = 1; touch <= 3; touch += 1) {
      await expectError(await ps.receipt(view.paymentId), 409, "payment_not_settled")
      expect(ps.gateway.cancelCalls).toHaveLength(touch)
      expect(ps.log.all("ps.settlement.failed")).toHaveLength(touch)
    }
    expect((await expectView(await ps.getPayment(view.paymentId), 200)).status).toBe("requires_payment")
    expect(ps.log.all("ps.settlement.failed").every((event) => event.data?.reason === "cancel_failed")).toBe(true)
    expect(ps.gateway.cancelCalls.every((id) => id === intentId)).toBe(true)
  })

  it("STR-5: a PaymentIntent that succeeds before the retried cancel settles the payment and gets a receipt", async () => {
    const ps = setupPaymentService({ stripe: true })
    const { view, intentId } = await expiringStripePayment(ps)
    ps.clock.advanceSeconds(61)
    ps.gateway.failCancels(1)
    await expectError(await ps.receipt(view.paymentId), 409, "payment_not_settled")

    // The payer still had the client secret and paid.
    ps.gateway.succeed(intentId)
    const receipt = await ps.receipt(view.paymentId)
    expect(receipt.status).toBe(200)
    expect((await expectView(await ps.getPayment(view.paymentId), 200)).status).toBe("settled")
    expect(ps.log.one("ps.settlement.confirmed").data).toMatchObject({ ref: intentId })
    expect(ps.log.all("ps.settlement.failed").map((event) => event.data?.reason)).toEqual(["cancel_failed"])
    // Verification saw the success first, so the cancel was not tried again.
    expect(ps.gateway.cancelCalls).toEqual([intentId])
  })

  it("STR-5: a succeeded webhook settles a payment whose cancel is outstanding", async () => {
    const ps = setupPaymentService({ stripe: true })
    const { view, intentId } = await expiringStripePayment(ps)
    ps.clock.advanceSeconds(61)
    ps.gateway.failCancels(1)
    await expectError(await ps.receipt(view.paymentId), 409, "payment_not_settled")
    ps.gateway.succeed(intentId)
    expect((await webhook(ps, ps.gateway.webhookBody("payment_intent.succeeded", intentId, "evt_late_success"))).status).toBe(200)
    expect((await expectView(await ps.getPayment(view.paymentId), 200)).status).toBe("settled")
    expect((await ps.receipt(view.paymentId)).status).toBe(200)
    expect(ps.gateway.cancelCalls).toEqual([intentId])
  })

  it("STR-5: a payment_failed webhook retries an outstanding cancel instead of logging a decline", async () => {
    const ps = setupPaymentService({ stripe: true })
    const { view, intentId } = await expiringStripePayment(ps)
    ps.clock.advanceSeconds(61)
    ps.gateway.failCancels(1)
    await expectError(await ps.receipt(view.paymentId), 409, "payment_not_settled")
    expect((await webhook(ps, ps.gateway.webhookBody("payment_intent.payment_failed", intentId, "evt_decline"))).status).toBe(200)
    expect((await expectView(await ps.getPayment(view.paymentId), 200)).status).toBe("failed")
    expect(ps.gateway.cancelCalls).toEqual([intentId, intentId])
    expect(ps.log.all("ps.settlement.failed").map((event) => event.data?.reason)).toEqual(["cancel_failed", "expired"])
  })

  it("STR-5: a cancel that a failing approval could not confirm is retried by the approver's next list and decision", async () => {
    const ps = setupPaymentService({ stripe: true })
    const auth = { Authorization: `Bearer ${APPROVER_TOKEN}` }
    // Stripe creates the PaymentIntent but the answer is lost, so settlement cannot start.
    vi.spyOn(ps.gateway, "createPaymentIntent").mockImplementationOnce(async (input) => {
      await FakeStripeGateway.prototype.createPaymentIntent.call(ps.gateway, input)
      throw new Error("the connection to Stripe timed out")
    })
    ps.gateway.failCancels(2)
    const { paymentRequestToken } = await ps.request({ amount: 7500 })
    const view = await expectView(await ps.initiate(paymentRequestToken, "stripe-usd"), 202)
    const approvalId = view.approvalId as string
    expect((await ps.post(`/approvals/${approvalId}/decision`, { decision: "approve" }, auth)).status).toBe(200)
    const intentId = ps.gateway.intents[0]?.id as string
    expect(ps.gateway.cancelCalls).toEqual([intentId])
    expect((await expectView(await ps.getPayment(view.paymentId), 200)).status).toBe("pending_approval")

    // The approver's list touches it: Stripe refuses again, so it still has not failed.
    expect((await ps.app.request("/approvals", { headers: auth })).status).toBe(200)
    expect(ps.gateway.cancelCalls).toEqual([intentId, intentId])
    expect((await expectView(await ps.getPayment(view.paymentId), 200)).status).toBe("pending_approval")

    // A decision touches it too; the cancel is confirmed, the payment fails, and the decision stays final.
    await expectError(await ps.post(`/approvals/${approvalId}/decision`, { decision: "reject" }, auth), 409, "approval_already_decided")
    expect(ps.gateway.cancelCalls).toEqual([intentId, intentId, intentId])
    expect(ps.gateway.intents[0]?.status).toBe("canceled")
    expect((await expectView(await ps.getPayment(view.paymentId), 200)).status).toBe("failed")
    expect(ps.log.all("ps.settlement.failed").map((event) => event.data?.reason)).toEqual(["cancel_failed", "cancel_failed", "failed"])
  })

  it("STR-5: a payment whose settlement never started and whose cancel is outstanding is never shown as payable", async () => {
    const ps = setupPaymentService({ stripe: true })
    vi.spyOn(ps.gateway, "createPaymentIntent").mockImplementationOnce(async (input) => {
      await FakeStripeGateway.prototype.createPaymentIntent.call(ps.gateway, input)
      throw new Error("the connection to Stripe timed out")
    })
    ps.gateway.failCancels(1)
    const { paymentRequestToken } = await ps.request()
    await expectError(await ps.initiate(paymentRequestToken, "stripe-usd"), 500, "internal_error")
    // The repeat and the read refuse rather than show requires_payment without a next action.
    await expectError(await ps.initiate(paymentRequestToken, "stripe-usd"), 500, "internal_error")
    await expectError(await ps.getPayment("pay_0001"), 500, "internal_error")
    expect(ps.log.one("ps.settlement.failed").data).toMatchObject({ reason: "cancel_failed", cause: "failed" })

    await expectError(await ps.receipt("pay_0001"), 409, "payment_not_settled")
    expect(ps.gateway.intents[0]?.status).toBe("canceled")
    expect((await expectView(await ps.getPayment("pay_0001"), 200)).status).toBe("failed")
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

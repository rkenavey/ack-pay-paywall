import { getDidResolver, verifyPaymentReceipt } from "agentcommercekit"
import * as v from "valibot"
import { afterEach, describe, expect, it, vi } from "vitest"
import { receiptBodySchema } from "@paywall/protocol"
import { buildInitiation, eventStrings, fixtures, JWT_PATTERN } from "@paywall/testkit"
import { expectError, expectView, RECEIPT_TTL_SECONDS, setupPaymentService, usd } from "./harness.ts"

afterEach(() => {
  vi.useRealTimers()
})

async function readReceipt(response: Response): Promise<string> {
  const raw = await response.json()
  expect(response.status, JSON.stringify(raw)).toBe(200)
  return v.parse(receiptBodySchema, raw).receipt
}

async function settledPayment(ps: ReturnType<typeof setupPaymentService>, amount = 500) {
  const { paymentRequestToken } = await ps.request({ amount })
  const view = await expectView(await ps.initiate(paymentRequestToken), 201)
  ps.clock.advanceSeconds(3)
  const settled = await expectView(await ps.settle(view.paymentId), 200)
  return { paymentRequestToken, view, settled, settledAt: ps.clock.now() }
}

describe("settlement and receipts", () => {
  it("PS-6: the sandbox settle call answers 200 settled", async () => {
    const ps = setupPaymentService()
    const { settled, view } = await settledPayment(ps)
    expect(settled).toEqual({ ...view, status: "settled", next: undefined })
    expect(settled).not.toHaveProperty("next")
    expect((await expectView(await ps.getPayment(view.paymentId), 200)).status).toBe("settled")
  })

  it("PS-6: after settlement the receipt route issues a receipt verifyPaymentReceipt accepts, with the token, option, metadata and expiry", async () => {
    const ps = setupPaymentService()
    const { paymentRequestToken, view, settledAt } = await settledPayment(ps)
    ps.clock.advanceSeconds(2)
    const jwt = await readReceipt(await ps.receipt(view.paymentId))

    const { receipt, paymentRequest } = await verifyPaymentReceipt(jwt, {
      resolver: getDidResolver(),
      trustedReceiptIssuers: [fixtures.paymentService.did],
      paymentRequestIssuer: fixtures.acme.did,
    })
    expect(receipt.type).toContain("PaymentReceiptCredential")
    expect(receipt.issuer.id).toBe(fixtures.paymentService.did)
    expect(receipt.credentialSubject.id).toBe(fixtures.client.did)
    expect(receipt.credentialSubject.paymentRequestToken).toBe(paymentRequestToken)
    expect(receipt.credentialSubject.paymentOptionId).toBe("sandbox-usd")
    expect(paymentRequest?.id).toBe("pr_0001")
    expect(receipt.expirationDate).toBe(new Date(settledAt.getTime() + RECEIPT_TTL_SECONDS * 1000).toISOString())

    const metadata = receipt.credentialSubject.metadata as Record<string, unknown>
    expect(metadata).toEqual({
      paymentId: view.paymentId,
      paymentRequestId: "pr_0001",
      network: "sandbox",
      amount: 500,
      decimals: 2,
      currency: "USD",
      payee: fixtures.acme.did,
      settlementRef: expect.stringMatching(/.+/),
      settledAt: settledAt.toISOString(),
    })
  })

  it("PS-6: the receipt route settles a sandbox payment that was marked paid but not yet confirmed", async () => {
    const ps = setupPaymentService()
    const { paymentRequestToken } = await ps.request()
    const view = await expectView(await ps.initiate(paymentRequestToken), 201)
    const record = await ps.payments.get(view.paymentId)
    if (!record) throw new Error("payment not stored")
    await ps.sandbox.markPaid(record, ps.clock.now())
    await readReceipt(await ps.receipt(view.paymentId))
    expect((await expectView(await ps.getPayment(view.paymentId), 200)).status).toBe("settled")
  })

  it("PS-7: the receipt route answers 409 payment_not_settled before settlement", async () => {
    const ps = setupPaymentService()
    const { paymentRequestToken } = await ps.request()
    const view = await expectView(await ps.initiate(paymentRequestToken), 201)
    await expectError(await ps.receipt(view.paymentId), 409, "payment_not_settled")
    expect((await expectView(await ps.getPayment(view.paymentId), 200)).status).toBe("requires_payment")
    expect(ps.log.names()).not.toContain("ps.receipt.issued")
  })

  it("PS-7: the receipt route answers 404 for an unknown payment", async () => {
    const ps = setupPaymentService()
    await expectError(await ps.receipt("pay_unknown"), 404, "payment_not_found")
  })

  it("PS-7: settling twice answers 409 payment_not_payable the second time", async () => {
    const ps = setupPaymentService()
    const { view } = await settledPayment(ps)
    await expectError(await ps.settle(view.paymentId), 409, "payment_not_payable")
    expect(ps.log.all("ps.settlement.confirmed")).toHaveLength(1)
  })

  it("PS-8: asking for the receipt again returns the identical JWT", async () => {
    const ps = setupPaymentService()
    const { view } = await settledPayment(ps)
    const first = await readReceipt(await ps.receipt(view.paymentId))
    ps.clock.advanceSeconds(30)
    const second = await readReceipt(await ps.receipt(view.paymentId))
    const [third, fourth] = await Promise.all([readReceipt(await ps.receipt(view.paymentId)), readReceipt(await ps.receipt(view.paymentId))])
    expect(second).toBe(first)
    expect(third).toBe(first)
    expect(fourth).toBe(first)
    expect(ps.log.all("ps.receipt.issued")).toHaveLength(1)
  })

  it("PS-9: the receipt metadata comes from the token even when the client sent other values", async () => {
    const ps = setupPaymentService()
    const { paymentRequestToken } = await ps.request({ amount: 500 })
    const initiation = await buildInitiation({
      paymentRequestToken,
      paymentOptionId: "sandbox-usd",
      claims: { amount: 1, currency: "EUR", payee: fixtures.globex.did },
    })
    const view = await expectView(await ps.post("/payments", { initiation, amount: 1, currency: "EUR", payee: fixtures.globex.did }), 201)
    await expectView(await ps.post(`/payments/${view.paymentId}/sandbox/settle`, { amount: 1, currency: "EUR" }), 200)
    const jwt = await readReceipt(await ps.post(`/payments/${view.paymentId}/receipt`, { amount: 1, payee: fixtures.globex.did }))
    const { receipt } = await verifyPaymentReceipt(jwt, { resolver: getDidResolver(), trustedReceiptIssuers: [fixtures.paymentService.did] })
    expect(receipt.credentialSubject.metadata).toMatchObject({ amount: 500, decimals: 2, currency: "USD", payee: fixtures.acme.did })
    expect((await expectView(await ps.getPayment(view.paymentId), 200)).amount).toEqual(usd(500))
  })

  it("PS-13: the happy path emits the payment service events in order, with the policy outcome and rule", async () => {
    const ps = setupPaymentService()
    const { view } = await settledPayment(ps)
    await readReceipt(await ps.receipt(view.paymentId))

    expect(ps.log.names("ps.")).toEqual([
      "ps.payment.initiated",
      "ps.policy.evaluated",
      "ps.settlement.started",
      "ps.settlement.confirmed",
      "ps.receipt.issued",
    ])
    for (const event of ps.log.events) expect(event.actor).toBe("payment-service")
    const policy = ps.log.one("ps.policy.evaluated")
    expect(policy.data).toMatchObject({ outcome: "allow", rule: "within_limits" })
    expect(policy.paymentRequestId).toBe("pr_0001")
    for (const name of ["ps.settlement.started", "ps.settlement.confirmed", "ps.receipt.issued"] as const) {
      expect(ps.log.one(name).paymentId).toBe(view.paymentId)
    }
  })

  it("PS-13: a denial is logged with its outcome and rule, and no settlement events follow", async () => {
    const ps = setupPaymentService()
    const { paymentRequestToken } = await ps.request({ issuer: fixtures.globex })
    await expectError(await ps.initiate(paymentRequestToken), 403, "policy_denied")
    expect(ps.log.names("ps.")).toEqual(["ps.payment.initiated", "ps.policy.evaluated"])
    expect(ps.log.one("ps.policy.evaluated").data).toMatchObject({ outcome: "deny", rule: "counterparty_not_allowed" })
  })

  it("PS-13: no event contains a complete JWT", async () => {
    const ps = setupPaymentService()
    const { view, paymentRequestToken } = await settledPayment(ps)
    const jwt = await readReceipt(await ps.receipt(view.paymentId))
    const serialized = JSON.stringify(ps.log.events)
    expect(serialized).not.toContain(jwt)
    expect(serialized).not.toContain(paymentRequestToken)
    for (const value of eventStrings(ps.log.events)) expect(value).not.toMatch(JWT_PATTERN)
  })
})

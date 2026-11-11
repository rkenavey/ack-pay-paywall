import { afterEach, describe, expect, it, vi } from "vitest"
import { buildInitiation, buildPaymentRequest, fixtures, paymentOption, tamperSignature } from "@paywall/testkit"
import { expectError, expectView, setupPaymentService, usd } from "./harness.ts"

afterEach(() => {
  vi.useRealTimers()
})

describe("initiating a payment", () => {
  it("PS-1: a valid initiation for the sandbox option answers 201 requires_payment with next sandbox_settle", async () => {
    const ps = setupPaymentService()
    const { paymentRequestToken } = await ps.request()
    const view = await expectView(await ps.initiate(paymentRequestToken, "sandbox-usd"), 201)
    expect(view).toEqual({
      paymentId: expect.any(String),
      status: "requires_payment",
      paymentRequestId: "pr_0001",
      paymentOptionId: "sandbox-usd",
      network: "sandbox",
      amount: usd(500),
      description: "Market brief",
      payer: fixtures.client.did,
      payee: fixtures.acme.did,
      policy: { outcome: "allow", rule: "within_limits" },
      next: { type: "sandbox_settle" },
    })
    expect(ps.beginCalls()).toBe(1)
    expect(await expectView(await ps.getPayment(view.paymentId), 200)).toEqual(view)
  })

  it("PS-1: an unknown payment answers 404 payment_not_found", async () => {
    const ps = setupPaymentService()
    await expectError(await ps.getPayment("pay_nope"), 404, "payment_not_found")
  })

  it("PS-2: an initiation with a bad signature answers 400 invalid_initiation", async () => {
    const ps = setupPaymentService()
    const { paymentRequestToken } = await ps.request()
    const tampered = tamperSignature(await buildInitiation({ paymentRequestToken, paymentOptionId: "sandbox-usd" }))
    await expectError(await ps.post("/payments", { initiation: tampered }), 400, "invalid_initiation")
    // Claims to be the client but is signed with another key.
    const impostor = await buildInitiation({ paymentRequestToken, paymentOptionId: "sandbox-usd", payer: fixtures.client, signer: fixtures.untrusted })
    await expectError(await ps.post("/payments", { initiation: impostor }), 400, "invalid_initiation")
    expect(ps.beginCalls()).toBe(0)
  })

  it("PS-2: an initiation with a wrong or missing audience answers 400 invalid_initiation", async () => {
    const ps = setupPaymentService()
    const { paymentRequestToken } = await ps.request()
    for (const audience of ["http://localhost:8787/other-service", "http://evil.example/payment-service", null]) {
      await expectError(await ps.initiate(paymentRequestToken, "sandbox-usd", { audience }), 400, "invalid_initiation")
    }
  })

  it("PS-2: an initiation expiring more than 300 s after iat, or never, answers 400 invalid_initiation", async () => {
    const ps = setupPaymentService()
    const { paymentRequestToken } = await ps.request()
    await expectError(await ps.initiate(paymentRequestToken, "sandbox-usd", { expiresIn: 301 }), 400, "invalid_initiation")
    await expectError(await ps.initiate(paymentRequestToken, "sandbox-usd", { expiresIn: 3600 }), 400, "invalid_initiation")
    await expectError(await ps.initiate(paymentRequestToken, "sandbox-usd", { expiresIn: null }), 400, "invalid_initiation")
    // Exactly 300 s is fine.
    await expectView(await ps.initiate(paymentRequestToken, "sandbox-usd", { expiresIn: 300 }), 201)
  })

  it("PS-2: an expired initiation answers 400 invalid_initiation", async () => {
    const ps = setupPaymentService()
    const { paymentRequestToken } = await ps.request()
    const initiation = await buildInitiation({ paymentRequestToken, paymentOptionId: "sandbox-usd", expiresIn: 60 })
    ps.clock.advanceSeconds(60 + 301) // beyond any clock-skew allowance
    await expectError(await ps.post("/payments", { initiation }), 400, "invalid_initiation")
  })

  it("PS-2: an initiation missing a claim, or a body without one, answers 400 invalid_initiation", async () => {
    const ps = setupPaymentService()
    const { paymentRequestToken } = await ps.request()
    const noOption = await buildInitiation({ paymentRequestToken })
    const noToken = await buildInitiation({ paymentOptionId: "sandbox-usd" })
    const numericOption = await buildInitiation({ paymentRequestToken, claims: { paymentOptionId: 7 } })
    for (const initiation of [noOption, noToken, numericOption]) {
      await expectError(await ps.post("/payments", { initiation }), 400, "invalid_initiation")
    }
    await expectError(await ps.post("/payments", {}), 400, "invalid_initiation")
    await expectError(await ps.post("/payments", { initiation: "not-a-jwt" }), 400, "invalid_initiation")
    await expectError(await ps.post("/payments", "{not json"), 400, "invalid_initiation")
    expect(ps.policyCalls).toHaveLength(0)
  })

  it("PS-3: a payment request token with a bad signature answers 400 payment_request_invalid", async () => {
    const ps = setupPaymentService()
    const { paymentRequestToken } = await ps.request()
    await expectError(await ps.initiate(tamperSignature(paymentRequestToken)), 400, "payment_request_invalid")

    const forged = await buildPaymentRequest({
      now: ps.clock.now(),
      issuer: { ...fixtures.acme, signer: fixtures.untrusted.signer },
      paymentOptions: [paymentOption({ network: "sandbox" })],
    })
    await expectError(await ps.initiate(forged.paymentRequestToken), 400, "payment_request_invalid")
    expect(ps.policyCalls).toHaveLength(0)
    expect(ps.beginCalls()).toBe(0)
  })

  it("PS-3: a payment request past its expiresAt answers 410 payment_request_expired", async () => {
    const ps = setupPaymentService()
    const expired = await ps.request({ expiresInMs: -1000 })
    await expectError(await ps.initiate(expired.paymentRequestToken), 410, "payment_request_expired")

    const live = await ps.request({ id: "pr_0002", expiresInMs: 60_000 })
    ps.clock.advanceSeconds(61)
    await expectError(await ps.initiate(live.paymentRequestToken), 410, "payment_request_expired")
    expect(ps.policyCalls).toHaveLength(0)
    expect(ps.beginCalls()).toBe(0)
  })

  it("PS-4: an unknown option id answers 400 payment_option_unknown", async () => {
    const ps = setupPaymentService()
    const { paymentRequestToken } = await ps.request()
    await expectError(await ps.initiate(paymentRequestToken, "lightning-usd"), 400, "payment_option_unknown")
  })

  it("PS-4: an option naming another payment service, another receipt service, an unsupported network or a string amount answers 400 payment_option_unsupported", async () => {
    const ps = setupPaymentService()
    const unsupported = [
      paymentOption({ network: "sandbox", id: "other-ps", paymentService: "http://elsewhere.example/payment-service" }),
      paymentOption({ network: "sandbox", id: "other-rs", receiptService: fixtures.untrusted.did }),
      paymentOption({ network: "lightning", id: "lightning-usd" }),
      paymentOption({ network: "stripe", id: "stripe-usd" }), // no Stripe adapter configured here
      paymentOption({ network: "sandbox", id: "string-amount", amount: "500" }),
    ]
    const { paymentRequestToken } = await buildPaymentRequest({ now: ps.clock.now(), paymentOptions: unsupported })
    for (const option of unsupported) {
      await expectError(await ps.initiate(paymentRequestToken, option.id), 400, "payment_option_unsupported")
    }
    expect(ps.policyCalls).toHaveLength(0)
    expect(ps.beginCalls()).toBe(0)
  })

  it("PS-5: repeating an initiation answers 200 with the same paymentId and starts no second settlement", async () => {
    const ps = setupPaymentService()
    const { paymentRequestToken } = await ps.request()
    const first = await expectView(await ps.initiate(paymentRequestToken), 201)
    const again = await expectView(await ps.initiate(paymentRequestToken), 200)
    expect(again).toEqual(first)
    // A fresh initiation JWT for the same payer, request and option is still a repeat.
    ps.clock.advanceSeconds(5)
    expect((await expectView(await ps.initiate(paymentRequestToken), 200)).paymentId).toBe(first.paymentId)
    expect(ps.beginCalls()).toBe(1)

    // A different option or a different payer is a different payment.
    const otherPayer = await expectView(await ps.initiate(paymentRequestToken, "sandbox-usd", { payer: fixtures.untrusted }), 201)
    expect(otherPayer.paymentId).not.toBe(first.paymentId)
    expect(otherPayer.payer).toBe(fixtures.untrusted.did)
  })

  it("PS-5: a repeat after settlement answers 200 with the settled payment", async () => {
    const ps = setupPaymentService()
    const { paymentRequestToken } = await ps.request()
    const first = await expectView(await ps.initiate(paymentRequestToken), 201)
    await expectView(await ps.settle(first.paymentId), 200)
    const again = await expectView(await ps.initiate(paymentRequestToken), 200)
    expect(again.paymentId).toBe(first.paymentId)
    expect(again.status).toBe("settled")
    expect(ps.beginCalls()).toBe(1)
  })

  it("PS-9: amount, currency and payee come from the token, not from the body or the initiation claims", async () => {
    const ps = setupPaymentService()
    const { paymentRequestToken } = await ps.request({ amount: 500 })
    const initiation = await buildInitiation({
      paymentRequestToken,
      paymentOptionId: "sandbox-usd",
      claims: { amount: 1, currency: "EUR", decimals: 0, payee: fixtures.globex.did, recipient: fixtures.globex.did },
    })
    const response = await ps.post("/payments", { initiation, amount: 1, currency: "EUR", payee: fixtures.globex.did })
    const view = await expectView(response, 201)
    expect(view.amount).toEqual(usd(500))
    expect(view.payee).toBe(fixtures.acme.did)
    expect(ps.policyCalls).toEqual([
      { payer: fixtures.client.did, counterparty: fixtures.acme.did, amount: usd(500), paymentRequestId: "pr_0001", description: "Market brief" },
    ])
  })

  it("PS-10: a policy deny answers 403 policy_denied with the rule, stores nothing and calls no adapter", async () => {
    const ps = setupPaymentService()
    const { paymentRequestToken } = await ps.request({ issuer: fixtures.globex })
    const details = await expectError(await ps.initiate(paymentRequestToken), 403, "policy_denied")
    expect(details?.rule).toBe("counterparty_not_allowed")
    expect(ps.policyCalls).toHaveLength(1)
    expect(ps.policyCalls[0]?.counterparty).toBe(fixtures.globex.did)
    await expect(ps.payments.findByKey(fixtures.client.did, "pr_0001", "sandbox-usd")).resolves.toBeUndefined()
    await expect(ps.approvals.list()).resolves.toEqual([])
    expect(ps.beginCalls()).toBe(0)

    // Denial is not remembered as a payment: asking again is evaluated again and denied again.
    await expectError(await ps.initiate(paymentRequestToken), 403, "policy_denied")
    expect(ps.policyCalls).toHaveLength(2)
  })

  it("PS-10: deny beats approval: an off-list counterparty above the threshold is denied, not held", async () => {
    const ps = setupPaymentService()
    const { paymentRequestToken } = await ps.request({ issuer: fixtures.globex, amount: 7500 })
    const details = await expectError(await ps.initiate(paymentRequestToken), 403, "policy_denied")
    expect(details?.rule).toBe("counterparty_not_allowed")
    await expect(ps.approvals.list()).resolves.toEqual([])
  })

  it("PS-11: a policy needs_approval answers 202 pending_approval with an approvalId and calls no adapter", async () => {
    const ps = setupPaymentService()
    const { paymentRequestToken } = await ps.request({ amount: 7500, description: "Annual report" })
    const view = await expectView(await ps.initiate(paymentRequestToken), 202)
    expect(view).toMatchObject({
      status: "pending_approval",
      amount: usd(7500),
      description: "Annual report",
      policy: { outcome: "needs_approval", rule: "amount_over_threshold", threshold: usd(5000) },
    })
    expect(view.approvalId).toEqual(expect.any(String))
    expect(view).not.toHaveProperty("next")
    expect(ps.beginCalls()).toBe(0)

    const approval = await ps.approvals.get(view.approvalId as string)
    expect(approval).toMatchObject({ id: view.approvalId, paymentId: view.paymentId, status: "pending", requestedAt: ps.clock.now() })

    // Repeating returns the same waiting payment and no new approval.
    expect((await expectView(await ps.initiate(paymentRequestToken), 200)).approvalId).toBe(view.approvalId)
    await expect(ps.approvals.list()).resolves.toHaveLength(1)
  })

  it("PS-12: while a payment is pending_approval, the settle and receipt routes answer 409", async () => {
    const ps = setupPaymentService()
    const { paymentRequestToken } = await ps.request({ amount: 7500 })
    const view = await expectView(await ps.initiate(paymentRequestToken), 202)
    await expectError(await ps.settle(view.paymentId), 409, "payment_not_payable")
    await expectError(await ps.receipt(view.paymentId), 409, "payment_not_settled")
    expect((await expectView(await ps.getPayment(view.paymentId), 200)).status).toBe("pending_approval")
    expect(ps.beginCalls()).toBe(0)
  })
})

// Live check against Stripe test mode. Run with `pnpm test:stripe-live`; it
// reads STRIPE_SECRET_KEY and STRIPE_PUBLISHABLE_KEY from .env and fails when
// they are missing. Never part of `pnpm test`.
import { getDidResolver, verifyPaymentReceipt } from "agentcommercekit"
import * as v from "valibot"
import { describe, expect, it } from "vitest"
import { paymentViewSchema, receiptBodySchema, systemClock, randomIds } from "@paywall/protocol"
import {
  createMemoryApprovalStore,
  createMemoryPaymentStore,
  createPaymentService,
  createStripeAdapter,
  createStripeGateway,
  evaluateSpend,
} from "@paywall/server"
import { buildInitiation, buildPaymentRequest, fixtures, MemoryEventLog, paymentOption, PAYMENT_SERVICE_URL } from "@paywall/testkit"

const secretKey = process.env.STRIPE_SECRET_KEY ?? ""
const publishableKey = process.env.STRIPE_PUBLISHABLE_KEY ?? ""

/** Confirms a PaymentIntent with Stripe's test card, standing in for the browser. */
async function confirmWithTestCard(intentId: string): Promise<void> {
  const response = await fetch(`https://api.stripe.com/v1/payment_intents/${intentId}/confirm`, {
    method: "POST",
    headers: { Authorization: `Bearer ${secretKey}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ payment_method: "pm_card_visa" }),
  })
  expect(response.status, await response.clone().text()).toBe(200)
}

async function retrieve(intentId: string): Promise<Record<string, unknown>> {
  const response = await fetch(`https://api.stripe.com/v1/payment_intents/${intentId}`, { headers: { Authorization: `Bearer ${secretKey}` } })
  return (await response.json()) as Record<string, unknown>
}

describe("Stripe test mode, live", () => {
  it("STR-10: a payment begins, is confirmed with pm_card_visa, settlement verifies and the receipt verifies", async () => {
    expect(secretKey, "STRIPE_SECRET_KEY must be set in .env").toMatch(/^(sk|rk)_test_/)
    expect(publishableKey, "STRIPE_PUBLISHABLE_KEY must be set in .env").toMatch(/^pk_test_/)

    const gateway = createStripeGateway({ secretKey })
    const app = createPaymentService({
      identity: fixtures.paymentService,
      publicUrl: PAYMENT_SERVICE_URL,
      policy: (request) => evaluateSpend(request, { allowedCounterparties: [fixtures.acme.did], approvalThreshold: { amount: 5000, decimals: 2, currency: "USD" } }),
      adapters: [createStripeAdapter({ gateway, publishableKey })],
      payments: createMemoryPaymentStore(),
      approvals: createMemoryApprovalStore(),
      approverToken: "live-test-approver-token-not-used-0000",
      receiptTtlSeconds: 600,
      stripe: { gateway, webhookConfigured: false },
      resolver: getDidResolver(),
      clock: systemClock,
      ids: randomIds,
      log: new MemoryEventLog(systemClock),
    })

    const { paymentRequestToken } = await buildPaymentRequest({
      now: systemClock.now(),
      id: randomIds.next("pr"),
      paymentOptions: [paymentOption({ network: "stripe", amount: 500 })],
    })
    const initiation = await buildInitiation({ paymentRequestToken, paymentOptionId: "stripe-usd" })
    const started = await app.request("/payments", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ initiation }) })
    expect(started.status).toBe(201)
    const view = v.parse(paymentViewSchema, await started.json())
    if (view.next?.type !== "stripe_payment_element") throw new Error("expected a Payment Element next action")
    expect(view.next.publishableKey).toBe(publishableKey)
    const intentId = view.next.clientSecret.split("_secret_")[0] as string

    const created = await retrieve(intentId)
    expect(created.amount).toBe(500)
    expect(created.currency).toBe("usd")
    expect(created.automatic_payment_methods).toMatchObject({ enabled: true, allow_redirects: "never" })
    expect(created.metadata).toMatchObject({ paymentId: view.paymentId, paymentOptionId: "stripe-usd", payer: fixtures.client.did })

    // Before confirmation there is no receipt.
    expect((await app.request(`/payments/${view.paymentId}/receipt`, { method: "POST" })).status).toBe(409)

    await confirmWithTestCard(intentId)
    const issued = await app.request(`/payments/${view.paymentId}/receipt`, { method: "POST" })
    expect(issued.status).toBe(200)
    const { receipt } = v.parse(receiptBodySchema, await issued.json())
    const verified = await verifyPaymentReceipt(receipt, {
      resolver: getDidResolver(),
      trustedReceiptIssuers: [fixtures.paymentService.did],
      paymentRequestIssuer: fixtures.acme.did,
    })
    expect(verified.receipt.credentialSubject.metadata).toMatchObject({ settlementRef: intentId, network: "stripe", amount: 500, currency: "USD" })
  })
})

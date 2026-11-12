import { getDidResolver, verifyPaymentRequestToken } from "agentcommercekit"
import * as v from "valibot"
import { afterEach, describe, expect, it, vi } from "vitest"
import { paymentRequiredBodySchema, paymentViewSchema, receiptBodySchema } from "@paywall/protocol"
import {
  buildInitiation,
  FakeStripeGateway,
  FAKE_STRIPE_KEYS,
  fixtureEnv,
  fixtureStripeEnv,
  MemoryEventLog,
  SequenceIds,
  teeEventLog,
  useFixedTime,
} from "@paywall/testkit"
import { buildApp, createConsoleEventLog, parseConfig } from "../../src/index.ts"
import { expectError, expectView, setupPaymentService } from "../payment-service/harness.ts"

afterEach(() => {
  vi.useRealTimers()
})

async function stripePayment(ps: ReturnType<typeof setupPaymentService>) {
  const { paymentRequestToken } = await ps.request()
  const view = await expectView(await ps.initiate(paymentRequestToken, "stripe-usd"), 201)
  const intentId = ps.gateway.intents[0]?.id as string
  return { view, intentId }
}

function webhook(ps: ReturnType<typeof setupPaymentService>, body: string, signature?: string) {
  return ps.app.request("/webhooks/stripe", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(signature === undefined ? {} : { "Stripe-Signature": signature }) },
    body,
  })
}

describe("Stripe webhook", () => {
  it("STR-5: a signed payment_intent.succeeded webhook settles the payment; the same event again changes nothing", async () => {
    const ps = setupPaymentService({ stripe: true })
    const { view, intentId } = await stripePayment(ps)
    ps.gateway.succeed(intentId)
    const body = ps.gateway.webhookBody("payment_intent.succeeded", intentId, "evt_0001")

    expect((await webhook(ps, body, ps.gateway.signWebhook(body))).status).toBe(200)
    expect((await expectView(await ps.getPayment(view.paymentId), 200)).status).toBe("settled")
    expect(ps.log.all("ps.settlement.confirmed")).toHaveLength(1)

    expect((await webhook(ps, body, ps.gateway.signWebhook(body))).status).toBe(200)
    expect((await expectView(await ps.getPayment(view.paymentId), 200)).status).toBe("settled")
    expect(ps.log.all("ps.settlement.confirmed")).toHaveLength(1)

    // The receipt is then issued without another settlement.
    expect((await ps.receipt(view.paymentId)).status).toBe(200)
  })

  it("STR-5: a succeeded webhook for a PaymentIntent Stripe does not report as succeeded does not settle", async () => {
    const ps = setupPaymentService({ stripe: true })
    const { view, intentId } = await stripePayment(ps)
    const body = ps.gateway.webhookBody("payment_intent.succeeded", intentId, "evt_0002")
    expect((await webhook(ps, body, ps.gateway.signWebhook(body))).status).toBe(200)
    expect((await expectView(await ps.getPayment(view.paymentId), 200)).status).toBe("requires_payment")
  })

  // spec-fix(T7): STR-5 was amended; payment_intent.payment_failed now leaves the payment in requires_payment so the payer can retry on the same PaymentIntent
  it("STR-5: payment_intent.payment_failed leaves the payment in requires_payment, and a later succeeded webhook settles it", async () => {
    const ps = setupPaymentService({ stripe: true })
    const { view, intentId } = await stripePayment(ps)
    ps.gateway.update(intentId, { status: "requires_payment_method" })
    const declined = ps.gateway.webhookBody("payment_intent.payment_failed", intentId, "evt_0003")
    expect((await webhook(ps, declined, ps.gateway.signWebhook(declined))).status).toBe(200)

    const waiting = await expectView(await ps.getPayment(view.paymentId), 200)
    expect(waiting.status).toBe("requires_payment")
    expect(waiting.next).toEqual(view.next)
    expect(ps.log.one("ps.settlement.failed").data).toMatchObject({ network: "stripe", reason: "declined", paymentIntent: intentId })
    await expectError(await ps.receipt(view.paymentId), 409, "payment_not_settled")
    expect(ps.gateway.cancelCalls).toEqual([])

    // The payer tries again on the same PaymentIntent and it succeeds.
    ps.gateway.succeed(intentId)
    const succeeded = ps.gateway.webhookBody("payment_intent.succeeded", intentId, "evt_0004")
    expect((await webhook(ps, succeeded, ps.gateway.signWebhook(succeeded))).status).toBe(200)
    expect((await expectView(await ps.getPayment(view.paymentId), 200)).status).toBe("settled")
    expect((await ps.receipt(view.paymentId)).status).toBe(200)
    expect(ps.gateway.cancelCalls).toEqual([])
  })

  it("STR-5: after a payment_failed webhook, a later success settles through the receipt route", async () => {
    const ps = setupPaymentService({ stripe: true })
    const { view, intentId } = await stripePayment(ps)
    const declined = ps.gateway.webhookBody("payment_intent.payment_failed", intentId, "evt_0005")
    expect((await webhook(ps, declined, ps.gateway.signWebhook(declined))).status).toBe(200)
    ps.gateway.succeed(intentId)
    expect((await ps.receipt(view.paymentId)).status).toBe(200)
    expect((await expectView(await ps.getPayment(view.paymentId), 200)).status).toBe("settled")
  })

  it("STR-5: a payment whose PaymentIntent was canceled fails, and the cancel is confirmed through the gateway", async () => {
    const ps = setupPaymentService({ stripe: true })
    const { view, intentId } = await stripePayment(ps)
    ps.gateway.update(intentId, { status: "canceled" })
    await expectError(await ps.receipt(view.paymentId), 409, "payment_not_settled")
    expect((await expectView(await ps.getPayment(view.paymentId), 200)).status).toBe("failed")
    expect(ps.gateway.cancelCalls).toEqual([intentId])
  })

  it("STR-5: a payment whose request expired before it was paid fails and its PaymentIntent is cancelled", async () => {
    const ps = setupPaymentService({ stripe: true })
    const { paymentRequestToken } = await ps.request({ expiresInMs: 60_000 })
    const view = await expectView(await ps.initiate(paymentRequestToken, "stripe-usd"), 201)
    const intentId = ps.gateway.intents[0]?.id as string
    ps.clock.advanceSeconds(61)
    await expectError(await ps.receipt(view.paymentId), 409, "payment_not_settled")
    const failed = await expectView(await ps.getPayment(view.paymentId), 200)
    expect(failed.status).toBe("failed")
    expect(failed.next).toBeUndefined()
    expect(ps.gateway.cancelCalls).toEqual([intentId])
    expect(ps.gateway.intents[0]?.status).toBe("canceled")
    expect(ps.log.one("ps.settlement.failed").data).toMatchObject({ reason: "expired" })
  })

  it("STR-5: other event types are acknowledged with 200 and ignored", async () => {
    const ps = setupPaymentService({ stripe: true })
    const { view, intentId } = await stripePayment(ps)
    const body = ps.gateway.webhookBody("payment_intent.created", intentId, "evt_0004")
    expect((await webhook(ps, body, ps.gateway.signWebhook(body))).status).toBe(200)
    expect((await expectView(await ps.getPayment(view.paymentId), 200)).status).toBe("requires_payment")
  })

  it("STR-6: a webhook with a bad or missing signature answers 400 and changes nothing", async () => {
    const ps = setupPaymentService({ stripe: true })
    const { view, intentId } = await stripePayment(ps)
    ps.gateway.succeed(intentId)
    const body = ps.gateway.webhookBody("payment_intent.succeeded", intentId, "evt_0005")
    const other = new FakeStripeGateway({ webhookSecret: "whsec_someone_else_000000000000000000" })

    await expectError(await webhook(ps, body), 400, "webhook_signature_invalid")
    await expectError(await webhook(ps, body, "v1=deadbeef"), 400, "webhook_signature_invalid")
    await expectError(await webhook(ps, body, other.signWebhook(body)), 400, "webhook_signature_invalid")
    // A valid signature over different bytes does not cover this body.
    await expectError(await webhook(ps, body, ps.gateway.signWebhook(`${body} `)), 400, "webhook_signature_invalid")

    expect((await expectView(await ps.getPayment(view.paymentId), 200)).status).toBe("requires_payment")
    expect(ps.log.names()).not.toContain("ps.settlement.confirmed")
  })

  it("STR-6: with no webhook secret the route answers 503 and processes nothing", async () => {
    const ps = setupPaymentService({ stripe: true, webhookConfigured: false })
    const { view, intentId } = await stripePayment(ps)
    ps.gateway.succeed(intentId)
    const body = ps.gateway.webhookBody("payment_intent.succeeded", intentId, "evt_0006")
    await expectError(await webhook(ps, body, ps.gateway.signWebhook(body)), 503, "webhook_not_configured")
    expect((await expectView(await ps.getPayment(view.paymentId), 200)).status).toBe("requires_payment")
  })
})

describe("Stripe configuration", () => {
  it("STR-7: config rejects live-mode keys", () => {
    const live = [
      { ...fixtureStripeEnv, STRIPE_SECRET_KEY: "sk_live_0000000000000000000000" },
      { ...fixtureStripeEnv, STRIPE_SECRET_KEY: "rk_live_0000000000000000000000" },
      { ...fixtureStripeEnv, STRIPE_PUBLISHABLE_KEY: "pk_live_0000000000000000000000" },
      { ...fixtureStripeEnv, STRIPE_SECRET_KEY: "not-a-key" },
    ]
    for (const env of live) {
      expect(() => parseConfig(fixtureEnv(env))).toThrow(/STRIPE_(SECRET|PUBLISHABLE)_KEY/)
    }
  })

  it("STR-7: config rejects a secret key without a publishable key, and a publishable key alone", () => {
    expect(() => parseConfig(fixtureEnv({ STRIPE_SECRET_KEY: FAKE_STRIPE_KEYS.secretKey }))).toThrow(/STRIPE_PUBLISHABLE_KEY/)
    expect(() => parseConfig(fixtureEnv({ STRIPE_PUBLISHABLE_KEY: FAKE_STRIPE_KEYS.publishableKey }))).toThrow(/STRIPE_SECRET_KEY/)
  })

  it("STR-7: error messages name the variable but never echo a key", () => {
    const secret = "sk_live_do_not_echo_this_value_123"
    let message = ""
    try {
      parseConfig(fixtureEnv({ ...fixtureStripeEnv, STRIPE_SECRET_KEY: secret }))
    } catch (error) {
      message = String(error)
    }
    expect(message).toMatch(/STRIPE_SECRET_KEY/)
    expect(message).not.toContain(secret)
  })

  it("STR-7: test-mode keys, including a restricted key, are accepted", () => {
    expect(parseConfig(fixtureEnv(fixtureStripeEnv)).stripe).toEqual({
      secretKey: FAKE_STRIPE_KEYS.secretKey,
      publishableKey: FAKE_STRIPE_KEYS.publishableKey,
      webhookSecret: FAKE_STRIPE_KEYS.webhookSecret,
    })
    const restricted = parseConfig(fixtureEnv({ ...fixtureStripeEnv, STRIPE_SECRET_KEY: "rk_test_restricted_000000000000" }))
    expect(restricted.stripe?.secretKey).toBe("rk_test_restricted_000000000000")
  })

  it("STR-7: with no Stripe keys the server starts and payment requests offer no Stripe option", async () => {
    const clock = useFixedTime()
    const config = parseConfig(fixtureEnv())
    expect(config.stripe).toBeUndefined()
    const app = buildApp(config, { clock, ids: new SequenceIds(), log: new MemoryEventLog(clock) })
    const response = await app.request("/api/resources/market-brief")
    expect(response.status).toBe(402)
    const body = v.parse(paymentRequiredBodySchema, await response.json())
    expect(body.paymentRequest.paymentOptions.map((o) => o.network)).toEqual(["sandbox"])
  })

  it("STR-7: with Stripe keys the payment requests offer a Stripe option", async () => {
    const clock = useFixedTime()
    const app = buildApp(parseConfig(fixtureEnv(fixtureStripeEnv)), {
      clock,
      ids: new SequenceIds(),
      log: new MemoryEventLog(clock),
      stripeGateway: new FakeStripeGateway(),
    })
    const body = v.parse(paymentRequiredBodySchema, await (await app.request("/api/resources/market-brief")).json())
    expect(body.paymentRequest.paymentOptions.map((o) => o.id).sort()).toEqual(["sandbox-usd", "stripe-usd"])
  })
})

describe("Stripe secrets", () => {
  it("STR-8: no event and no log line contains the Stripe secret key or a client secret", async () => {
    const clock = useFixedTime()
    const memory = new MemoryEventLog(clock)
    const lines: string[] = []
    for (const format of ["pretty", "json"] as const) {
      const gateway = new FakeStripeGateway()
      const linesBefore = lines.length
      const consoleLog = createConsoleEventLog({ format, clock, write: (line) => lines.push(line) })
      const app = buildApp(parseConfig(fixtureEnv({ ...fixtureStripeEnv, LOG_FORMAT: format })), {
        clock,
        ids: new SequenceIds(),
        log: teeEventLog(memory, consoleLog),
        stripeGateway: gateway,
      })
      const paymentRequired = v.parse(paymentRequiredBodySchema, await (await app.request("/api/resources/market-brief")).json())
      await verifyPaymentRequestToken(paymentRequired.paymentRequestToken, { resolver: getDidResolver() })
      const initiation = await buildInitiation({ paymentRequestToken: paymentRequired.paymentRequestToken, paymentOptionId: "stripe-usd" })
      const initiated = await app.request("/payment-service/payments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ initiation }),
      })
      const view = v.parse(paymentViewSchema, await initiated.json())
      const clientSecret = view.next?.type === "stripe_payment_element" ? view.next.clientSecret : ""
      expect(clientSecret).not.toBe("")
      gateway.succeed(gateway.intentIdForClientSecret(clientSecret))
      const receipt = v.parse(receiptBodySchema, await (await app.request(`/payment-service/payments/${view.paymentId}/receipt`, { method: "POST" })).json())
      await app.request("/api/resources/market-brief", { headers: { "Payment-Receipt": receipt.receipt } })

      const everything = [JSON.stringify(memory.events), ...lines].join("\n")
      expect(lines.length).toBeGreaterThan(linesBefore)
      expect(everything).not.toContain(FAKE_STRIPE_KEYS.secretKey)
      expect(everything).not.toContain(FAKE_STRIPE_KEYS.webhookSecret)
      expect(everything).not.toContain(clientSecret)
      expect(everything).not.toContain(receipt.receipt)
    }
  })
})

import { createHmac, timingSafeEqual } from "node:crypto"
import type { CreatePaymentIntentInput, PaymentIntentSnapshot, StripeGateway } from "@paywall/server"

/** The test-mode key pair the tests configure. Not real keys. */
export const FAKE_STRIPE_KEYS = {
  secretKey: "sk_test_fixture_secret_0000000000000000",
  publishableKey: "pk_test_fixture_publishable_00000000000",
  webhookSecret: "whsec_fixture_webhook_secret_000000000",
} as const

/**
 * A stand-in for Stripe behind the `StripeGateway` seam.
 *
 * PaymentIntents start in `requires_payment_method`; a test moves them with
 * {@link FakeStripeGateway.succeed} or {@link FakeStripeGateway.update}.
 * `createPaymentIntent` honours idempotency keys the way Stripe does: the
 * same key returns the same PaymentIntent. Webhooks are signed with an HMAC
 * of the raw body under the webhook secret; {@link FakeStripeGateway.signWebhook}
 * produces a valid signature.
 */
export class FakeStripeGateway implements StripeGateway {
  /** Every `createPaymentIntent` call, in order, including idempotent repeats. */
  readonly createCalls: CreatePaymentIntentInput[] = []
  readonly #intents = new Map<string, PaymentIntentSnapshot & { clientSecret: string }>()
  readonly #byKey = new Map<string, string>()
  readonly #webhookSecret: string
  #count = 0

  constructor(options: { webhookSecret?: string } = {}) {
    this.#webhookSecret = options.webhookSecret ?? FAKE_STRIPE_KEYS.webhookSecret
  }

  async createPaymentIntent(input: CreatePaymentIntentInput): Promise<{ id: string; clientSecret: string }> {
    this.createCalls.push(structuredClone(input))
    const existing = this.#byKey.get(input.idempotencyKey)
    if (existing) {
      const intent = this.#intents.get(existing)
      if (intent) return { id: intent.id, clientSecret: intent.clientSecret }
    }
    this.#count += 1
    const id = `pi_fake_${String(this.#count).padStart(4, "0")}`
    const clientSecret = `${id}_secret_fixture${this.#count}`
    this.#intents.set(id, {
      id,
      clientSecret,
      status: "requires_payment_method",
      amount: input.amount,
      amountReceived: 0,
      currency: input.currency.toLowerCase(),
      metadata: { ...input.metadata },
    })
    this.#byKey.set(input.idempotencyKey, id)
    return { id, clientSecret }
  }

  async retrievePaymentIntent(id: string): Promise<PaymentIntentSnapshot> {
    const intent = this.#intents.get(id)
    if (!intent) throw new Error(`No such payment_intent: '${id}'`)
    const { clientSecret, ...snapshot } = intent
    void clientSecret
    return structuredClone(snapshot)
  }

  constructWebhookEvent(rawBody: string, signature: string): { id: string; type: string; paymentIntentId?: string } {
    const expected = Buffer.from(this.signWebhook(rawBody))
    const given = Buffer.from(signature)
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
      throw new Error("No signatures found matching the expected signature for payload")
    }
    const event = JSON.parse(rawBody) as { id: string; type: string; data?: { object?: { id?: string; object?: string } } }
    const object = event.data?.object
    return {
      id: event.id,
      type: event.type,
      ...(object?.object === "payment_intent" && object.id ? { paymentIntentId: object.id } : {}),
    }
  }

  /** The PaymentIntents created so far. */
  get intents(): PaymentIntentSnapshot[] {
    return [...this.#intents.values()].map((intent) => {
      const { clientSecret, ...snapshot } = intent
      void clientSecret
      return structuredClone(snapshot)
    })
  }

  /** The id of the PaymentIntent a client secret belongs to. */
  intentIdForClientSecret(clientSecret: string): string {
    for (const intent of this.#intents.values()) if (intent.clientSecret === clientSecret) return intent.id
    throw new Error("unknown client secret")
  }

  /** Marks the PaymentIntent succeeded with the full amount received, as a confirmed card payment would. */
  succeed(id: string): void {
    const intent = this.#intent(id)
    intent.status = "succeeded"
    intent.amountReceived = intent.amount
  }

  /** Changes fields of a PaymentIntent, such as its status, amounts, currency or metadata. */
  update(id: string, patch: Partial<Omit<PaymentIntentSnapshot, "id">>): void {
    Object.assign(this.#intent(id), structuredClone(patch))
  }

  /** The `Stripe-Signature` value that makes `constructWebhookEvent` accept `rawBody`. */
  signWebhook(rawBody: string): string {
    return `v1=${createHmac("sha256", this.#webhookSecret).update(rawBody).digest("hex")}`
  }

  /** A webhook event body about a PaymentIntent. */
  webhookBody(type: string, paymentIntentId: string, eventId = `evt_fake_${paymentIntentId}_${type}`): string {
    return JSON.stringify({ id: eventId, object: "event", type, data: { object: { id: paymentIntentId, object: "payment_intent" } } })
  }

  #intent(id: string): PaymentIntentSnapshot & { clientSecret: string } {
    const intent = this.#intents.get(id)
    if (!intent) throw new Error(`No such payment_intent: '${id}'`)
    return intent
  }
}

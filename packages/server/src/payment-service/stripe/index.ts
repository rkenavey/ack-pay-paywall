import Stripe from "stripe"
import { systemClock, type Clock } from "@paywall/protocol"
import type { CreatePaymentIntentInput, PaymentIntentSnapshot, SettlementResult, StripeAdapter, StripeGateway } from "../types.ts"

// PaymentIntent statuses that may still turn into a payment. `requires_payment_method`
// is among them: after a decline the payer can try again on the same PaymentIntent.
const STILL_PAYABLE = new Set(["requires_payment_method", "requires_confirmation", "requires_action", "processing", "requires_capture"])

/**
 * Creates the Stripe settlement adapter.
 *
 * `begin` creates one PaymentIntent per payment through the gateway, with the
 * idempotency key `pi:<paymentId>`, and returns the client secret with
 * `publishableKey` for the browser. `verify` retrieves the PaymentIntent and
 * accepts it only when it succeeded for the expected amount, currency and
 * payment id. `cancel` cancels the payment's PaymentIntent through the
 * gateway, and does nothing when none was created. When creating the
 * PaymentIntent threw, Stripe may have created it anyway, so `cancel`
 * repeats the create with the same idempotency key and cancels the result.
 *
 * `clock` stamps the settlement time when `verify` first sees the
 * PaymentIntent succeeded; it defaults to the system clock. The adapter
 * remembers which PaymentIntent belongs to which payment in process memory.
 */
export function createStripeAdapter(options: { gateway: StripeGateway; publishableKey: string; clock?: Clock }): StripeAdapter {
  const { gateway, publishableKey } = options
  const clock = options.clock ?? systemClock
  const intents = new Map<string, { id: string; clientSecret: string }>()
  // Create calls that threw: Stripe may still have created the PaymentIntent, so cancel replays them.
  const uncertain = new Map<string, CreatePaymentIntentInput>()
  const settledAt = new Map<string, Date>()

  return {
    network: "stripe",

    async begin(payment) {
      if (payment.network !== "stripe") throw new Error(`the Stripe adapter cannot begin a ${payment.network} payment`)
      // Stripe amounts are in the currency's minor unit; only two-decimal currencies are offered.
      if (payment.amount.decimals !== 2) throw new Error("the Stripe adapter only settles two-decimal currencies")
      let intent = intents.get(payment.id)
      if (!intent) {
        const input: CreatePaymentIntentInput = {
          amount: payment.amount.amount,
          currency: payment.amount.currency.toLowerCase(),
          ...(payment.description === undefined ? {} : { description: payment.description }),
          metadata: {
            paymentId: payment.id,
            paymentRequestId: payment.paymentRequestId,
            paymentOptionId: payment.paymentOptionId,
            payer: payment.payer,
          },
          idempotencyKey: `pi:${payment.id}`,
        }
        try {
          intent = await gateway.createPaymentIntent(input)
        } catch (error) {
          uncertain.set(payment.id, input)
          throw error
        }
        uncertain.delete(payment.id)
        intents.set(payment.id, intent)
      }
      return { type: "stripe_payment_element", clientSecret: intent.clientSecret, publishableKey }
    },

    async verify(payment): Promise<SettlementResult> {
      const known = intents.get(payment.id)
      if (!known) return { settled: false, reason: "pending", detail: "no PaymentIntent was created for this payment" }
      const intent = await gateway.retrievePaymentIntent(known.id)
      if (intent.status !== "succeeded") {
        if (STILL_PAYABLE.has(intent.status)) return { settled: false, reason: "pending", detail: `the PaymentIntent is ${intent.status}` }
        return { settled: false, reason: "failed", detail: `the PaymentIntent is ${intent.status}` }
      }
      const problem = mismatch(intent, payment.id, payment.amount.amount, payment.amount.currency)
      if (problem) return { settled: false, reason: "mismatch", detail: problem }
      let at = settledAt.get(payment.id)
      if (!at) {
        at = clock.now()
        settledAt.set(payment.id, at)
      }
      return { settled: true, ref: intent.id, settledAt: new Date(at.getTime()) }
    },

    async cancel(payment) {
      let id = intents.get(payment.id)?.id
      const attempted = uncertain.get(payment.id)
      if (!id && attempted) {
        // The same idempotency key returns the PaymentIntent Stripe created, if it created one.
        // Remember it, so a retry after a failed cancel still knows what to cancel.
        const intent = await gateway.createPaymentIntent(attempted)
        intents.set(payment.id, intent)
        uncertain.delete(payment.id)
        id = intent.id
      }
      if (id) await gateway.cancelPaymentIntent(id)
    },
  }
}

/** Why a succeeded PaymentIntent is not the payment we expected, or undefined when it is. */
function mismatch(intent: PaymentIntentSnapshot, paymentId: string, amount: number, currency: string): string | undefined {
  if (intent.metadata.paymentId !== paymentId) return "the PaymentIntent belongs to another payment"
  if (intent.amount !== amount) return "the PaymentIntent is for another amount"
  if (intent.amountReceived !== amount) return "the amount received differs from the amount due"
  if (intent.currency.toLowerCase() !== currency.toLowerCase()) return "the PaymentIntent is in another currency"
  return undefined
}

/**
 * Creates the real gateway over the Stripe SDK. Accepts test-mode keys only.
 * Without `webhookSecret`, `constructWebhookEvent` always throws.
 *
 * PaymentIntents are created with automatic payment methods that never
 * redirect, so the Payment Element offers only methods that complete in the
 * page. Errors from Stripe are passed through; they never contain the key.
 * `cancelPaymentIntent` resolves for a PaymentIntent that is already
 * canceled and rejects for one Stripe will not cancel, such as one that
 * has succeeded.
 */
export function createStripeGateway(options: { secretKey: string; webhookSecret?: string }): StripeGateway {
  if (!/^(sk|rk)_test_/.test(options.secretKey)) throw new Error("the Stripe gateway accepts only a test-mode secret key")
  const { webhookSecret } = options
  const stripe = new Stripe(options.secretKey, { maxNetworkRetries: 2, timeout: 20_000 })

  return {
    async createPaymentIntent(input) {
      const intent = await stripe.paymentIntents.create(
        {
          amount: input.amount,
          currency: input.currency,
          ...(input.description === undefined ? {} : { description: input.description }),
          metadata: input.metadata,
          automatic_payment_methods: { enabled: true, allow_redirects: "never" },
        },
        { idempotencyKey: input.idempotencyKey },
      )
      if (!intent.client_secret) throw new Error("Stripe returned a PaymentIntent without a client secret")
      return { id: intent.id, clientSecret: intent.client_secret }
    },

    async retrievePaymentIntent(id) {
      const intent = await stripe.paymentIntents.retrieve(id)
      return {
        id: intent.id,
        status: intent.status,
        amount: intent.amount,
        amountReceived: intent.amount_received,
        currency: intent.currency,
        metadata: { ...intent.metadata },
      }
    },

    async cancelPaymentIntent(id) {
      try {
        await stripe.paymentIntents.cancel(id)
      } catch (error) {
        // Stripe refuses to cancel a PaymentIntent that is already canceled, which is the outcome wanted.
        const intent = await stripe.paymentIntents.retrieve(id)
        if (intent.status !== "canceled") throw error
      }
    },

    constructWebhookEvent(rawBody, signature) {
      if (!webhookSecret) throw new Error("no webhook signing secret is configured")
      const event = stripe.webhooks.constructEvent(rawBody, signature, webhookSecret)
      const object = event.data.object as { id?: unknown; object?: unknown }
      return {
        id: event.id,
        type: event.type,
        ...(object.object === "payment_intent" && typeof object.id === "string" ? { paymentIntentId: object.id } : {}),
      }
    },
  }
}

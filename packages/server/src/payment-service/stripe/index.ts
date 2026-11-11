import { NotImplementedError } from "@paywall/protocol"
import type { SettlementAdapter, StripeGateway } from "../types.ts"

/**
 * Creates the Stripe settlement adapter.
 *
 * `begin` creates one PaymentIntent per payment through the gateway, with the
 * idempotency key `pi:<paymentId>`, and returns the client secret with
 * `publishableKey` for the browser. `verify` retrieves the PaymentIntent and
 * accepts it only when it succeeded for the expected amount, currency and
 * payment id.
 */
export function createStripeAdapter(options: { gateway: StripeGateway; publishableKey: string }): SettlementAdapter {
  void options
  throw new NotImplementedError("T5")
}

/**
 * Creates the real gateway over the Stripe SDK. Accepts test-mode keys only.
 * Without `webhookSecret`, `constructWebhookEvent` always throws.
 */
export function createStripeGateway(options: { secretKey: string; webhookSecret?: string }): StripeGateway {
  void options
  throw new NotImplementedError("T5")
}

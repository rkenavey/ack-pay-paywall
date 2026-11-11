import type { ReactElement } from "react"
import { NotImplementedError } from "@paywall/protocol"
import type { PaymentExecutor } from "../agent/index.ts"

/**
 * What the Stripe checkout is doing: `idle` until a payment needs the Payment
 * Element, `ready` while it is mounted, `submitting` while `confirmPayment`
 * runs, and `succeeded` once Stripe.js reports success. `error` is the
 * message from the last failed attempt.
 */
export interface StripeCheckoutState {
  status: "idle" | "ready" | "submitting" | "succeeded"
  clientSecret?: string
  publishableKey?: string
  error?: string
}

/**
 * Connects the client agent to the Payment Element. The agent runs
 * `executor`; the page renders {@link StripePaymentForm} with this checkout,
 * which mounts the element and resolves the executor when the payment is
 * confirmed in the browser.
 */
export interface StripeCheckout {
  readonly executor: PaymentExecutor
  subscribe(listener: () => void): () => void
  getSnapshot(): StripeCheckoutState
}

/**
 * Creates the Stripe checkout. `returnUrl` is passed to `confirmPayment` for
 * payment methods that must redirect; card payments complete in the page.
 */
export function createStripeCheckout(options: { returnUrl: string }): StripeCheckout {
  void options
  throw new NotImplementedError("T5")
}

/**
 * Renders the Payment Element for the checkout's current payment and a Pay
 * button that calls `confirmPayment` with `redirect: "if_required"`. Shows the
 * error message when confirmation fails and lets the user try again. Renders
 * nothing while no payment is waiting.
 */
export function StripePaymentForm(props: { checkout: StripeCheckout }): ReactElement | null {
  void props
  throw new NotImplementedError("T5")
}

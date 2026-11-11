import { Elements, PaymentElement, useElements, useStripe } from "@stripe/react-stripe-js"
import { loadStripe, type Stripe } from "@stripe/stripe-js"
import { useState, useSyncExternalStore, type FormEvent, type ReactElement } from "react"
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

/** What the form reports back to its checkout. Kept off the public interface. */
interface CheckoutControl {
  returnUrl: string
  submitting(): void
  failed(message: string): void
  succeeded(): void
}

const controls = new WeakMap<StripeCheckout, CheckoutControl>()

// Stripe.js is loaded once per publishable key, outside render, as Stripe recommends.
const stripeByKey = new Map<string, Promise<Stripe | null>>()
function stripeFor(publishableKey: string): Promise<Stripe | null> {
  let stripe = stripeByKey.get(publishableKey)
  if (!stripe) {
    stripe = loadStripe(publishableKey)
    stripeByKey.set(publishableKey, stripe)
  }
  return stripe
}

/** How often the form re-reads a PaymentIntent that Stripe reports as still processing. */
const PROCESSING_POLL_MS = 2000

/**
 * Creates the Stripe checkout. `returnUrl` is passed to `confirmPayment` for
 * payment methods that must redirect; card payments complete in the page.
 *
 * One payment at a time: the executor rejects when the run's signal aborts,
 * and a new payment replaces one that is still waiting.
 */
export function createStripeCheckout(options: { returnUrl: string }): StripeCheckout {
  let state: StripeCheckoutState = { status: "idle" }
  const listeners = new Set<() => void>()
  let pending: { resolve: () => void; reject: (error: Error) => void } | undefined

  const set = (next: StripeCheckoutState) => {
    state = next
    for (const listener of listeners) listener()
  }
  const settle = (outcome: "resolve" | Error) => {
    const current = pending
    pending = undefined
    if (!current) return
    if (outcome === "resolve") current.resolve()
    else current.reject(outcome)
  }

  const checkout: StripeCheckout = {
    executor: {
      network: "stripe",
      execute({ next, signal }) {
        if (next.type !== "stripe_payment_element") return Promise.reject(new Error(`the Stripe executor cannot handle ${next.type}`))
        if (signal.aborted) return Promise.reject(new Error("the payment was aborted"))
        settle(new Error("another payment replaced this one"))
        return new Promise<void>((resolve, reject) => {
          pending = { resolve, reject }
          set({ status: "ready", clientSecret: next.clientSecret, publishableKey: next.publishableKey })
          signal.addEventListener(
            "abort",
            () => {
              if (pending?.resolve !== resolve) return
              settle(new Error("the payment was aborted"))
              set({ status: "idle" })
            },
            { once: true },
          )
        })
      },
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    getSnapshot: () => state,
  }

  controls.set(checkout, {
    returnUrl: options.returnUrl,
    submitting: () => {
      if (state.status === "ready") set({ ...without(state, "error"), status: "submitting" })
    },
    failed: (message) => {
      if (state.status === "submitting") set({ ...state, status: "ready", error: message })
    },
    succeeded: () => {
      if (state.status !== "submitting") return
      set({ ...without(state, "error"), status: "succeeded" })
      settle("resolve")
    },
  })
  return checkout
}

function without<T extends object, K extends keyof T>(value: T, key: K): Omit<T, K> {
  const copy = { ...value }
  delete copy[key]
  return copy
}

/**
 * Renders the Payment Element for the checkout's current payment and a Pay
 * button that calls `confirmPayment` with `redirect: "if_required"`. Shows the
 * error message when confirmation fails and lets the user try again. Renders
 * nothing while no payment is waiting.
 */
export function StripePaymentForm(props: { checkout: StripeCheckout }): ReactElement | null {
  const { checkout } = props
  const state = useSyncExternalStore(checkout.subscribe, checkout.getSnapshot)
  const control = controls.get(checkout)
  if (state.status === "idle" || !state.clientSecret || !state.publishableKey || !control) return null
  return (
    <section aria-labelledby="stripe-heading" className="stripe-checkout">
      <h3 id="stripe-heading">Card payment (Stripe test mode)</h3>
      <Elements key={state.clientSecret} stripe={stripeFor(state.publishableKey)} options={{ clientSecret: state.clientSecret }}>
        <CheckoutForm state={state} control={control} clientSecret={state.clientSecret} />
      </Elements>
    </section>
  )
}

function CheckoutForm(props: { state: StripeCheckoutState; control: CheckoutControl; clientSecret: string }): ReactElement {
  const { state, control, clientSecret } = props
  const stripe = useStripe()
  const elements = useElements()
  const [note, setNote] = useState<string | undefined>()

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!stripe || !elements || state.status !== "ready") return
    control.submitting()
    setNote(undefined)
    try {
      const result = await stripe.confirmPayment({ elements, confirmParams: { return_url: control.returnUrl }, redirect: "if_required" })
      if (result.error) {
        control.failed(result.error.message ?? "The payment could not be confirmed.")
        return
      }
      let status = result.paymentIntent.status
      // A payment that is still processing is waited out here, so the receipt is asked for only once it has gone through.
      while (status === "processing") {
        setNote("Stripe is still processing the payment…")
        await new Promise((resolve) => setTimeout(resolve, PROCESSING_POLL_MS))
        const latest = await stripe.retrievePaymentIntent(clientSecret)
        if (latest.error || !latest.paymentIntent) {
          control.failed(latest.error?.message ?? "The payment status could not be read.")
          return
        }
        status = latest.paymentIntent.status
      }
      setNote(undefined)
      if (status === "succeeded") control.succeeded()
      else control.failed(status === "requires_payment_method" ? "The payment was not completed. Try again." : `The payment is ${status}.`)
    } catch (error) {
      control.failed(error instanceof Error ? error.message : "The payment could not be confirmed.")
    }
  }

  const busy = state.status === "submitting"
  return (
    <form onSubmit={(event) => void submit(event)}>
      <PaymentElement />
      {state.error && (
        <p role="alert" className="error">
          {state.error}
        </p>
      )}
      {note && <p>{note}</p>}
      {state.status === "succeeded" ? (
        <p>Payment confirmed by Stripe.</p>
      ) : (
        <button type="submit" disabled={!stripe || !elements || busy}>
          {busy ? "Paying…" : "Pay"}
        </button>
      )}
    </form>
  )
}

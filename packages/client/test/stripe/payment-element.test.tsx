import { act, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { ReactNode } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { PaymentView } from "@paywall/protocol"
import { fixtures, PAYMENT_SERVICE_URL } from "@paywall/testkit"

// Stripe.js is replaced at the module boundary: no network, no iframe.
const stripe = vi.hoisted(() => ({
  loadStripe: vi.fn(),
  confirmPayment: vi.fn(),
  elementsProps: [] as Array<{ options?: { clientSecret?: string } }>,
  elements: { id: "elements-instance" },
}))

vi.mock("@stripe/stripe-js", () => ({
  loadStripe: stripe.loadStripe,
}))

vi.mock("@stripe/react-stripe-js", () => ({
  Elements: (props: { options?: { clientSecret?: string }; children?: ReactNode }) => {
    stripe.elementsProps.push({ ...(props.options ? { options: props.options } : {}) })
    return <div data-testid="stripe-elements">{props.children}</div>
  },
  PaymentElement: () => <div data-testid="payment-element" />,
  useStripe: () => ({ confirmPayment: stripe.confirmPayment }),
  useElements: () => stripe.elements,
}))

const { createStripeCheckout, StripePaymentForm } = await import("../../src/stripe/index.tsx")

const next = { type: "stripe_payment_element" as const, clientSecret: "pi_fake_0001_secret_fixture1", publishableKey: "pk_test_fixture_publishable" }
const payment: PaymentView = {
  paymentId: "pay_0001",
  status: "requires_payment",
  paymentRequestId: "pr_0001",
  paymentOptionId: "stripe-usd",
  network: "stripe",
  amount: { amount: 500, decimals: 2, currency: "USD" },
  description: "Market brief",
  payer: fixtures.client.did,
  payee: fixtures.acme.did,
  policy: { outcome: "allow", rule: "within_limits" },
  next,
}

beforeEach(() => {
  stripe.loadStripe.mockReset()
  stripe.confirmPayment.mockReset()
  stripe.elementsProps.length = 0
  stripe.loadStripe.mockResolvedValue({ confirmPayment: stripe.confirmPayment })
})

afterEach(() => {
  vi.useRealTimers()
})

function setup(publishableKey: string = next.publishableKey) {
  const checkout = createStripeCheckout({ returnUrl: "http://localhost:5173/" })
  render(<StripePaymentForm checkout={checkout} />)
  let resolved = false
  let rejected: unknown
  const action = { ...next, publishableKey }
  const execution = checkout.executor
    .execute({ payment: { ...payment, next: action }, next: action, paymentServiceUrl: PAYMENT_SERVICE_URL, fetch, signal: new AbortController().signal })
    .then(
      () => {
        resolved = true
      },
      (error: unknown) => {
        rejected = error
      },
    )
  return { checkout, execution, isResolved: () => resolved, rejection: () => rejected }
}

describe("Stripe Payment Element executor", () => {
  it("STR-9: the executor is for the stripe network", () => {
    expect(createStripeCheckout({ returnUrl: "http://localhost:5173/" }).executor.network).toBe("stripe")
  })

  it("STR-9: it mounts the Payment Element with the client secret and loads Stripe.js with the publishable key", async () => {
    // A key no other test uses, so a memoised load cannot hide the call.
    setup("pk_test_mount_check_0000000000")
    expect(await screen.findByTestId("payment-element")).toBeInTheDocument()
    expect(stripe.loadStripe).toHaveBeenCalledWith("pk_test_mount_check_0000000000")
    expect(stripe.elementsProps.at(-1)?.options?.clientSecret).toBe(next.clientSecret)
  })

  it('STR-9: submitting calls confirmPayment with redirect "if_required" and the executor resolves on success', async () => {
    stripe.confirmPayment.mockResolvedValue({ paymentIntent: { id: "pi_fake_0001", status: "succeeded" } })
    const { execution, isResolved } = setup()
    await screen.findByTestId("payment-element")
    expect(isResolved()).toBe(false)

    await userEvent.click(screen.getByRole("button", { name: /pay/i }))
    await act(() => execution)
    expect(isResolved()).toBe(true)
    expect(stripe.confirmPayment).toHaveBeenCalledTimes(1)
    expect(stripe.confirmPayment).toHaveBeenCalledWith({
      elements: stripe.elements,
      confirmParams: { return_url: "http://localhost:5173/" },
      redirect: "if_required",
    })
  })

  it("STR-9: on an error it shows the message and lets the user submit again on the same PaymentIntent", async () => {
    stripe.confirmPayment
      .mockResolvedValueOnce({ error: { type: "card_error", message: "Your card was declined." } })
      .mockResolvedValueOnce({ paymentIntent: { id: "pi_fake_0001", status: "succeeded" } })
    const { execution, isResolved, rejection } = setup()
    await screen.findByTestId("payment-element")

    await userEvent.click(screen.getByRole("button", { name: /pay/i }))
    expect(await screen.findByText("Your card was declined.")).toBeInTheDocument()
    expect(isResolved()).toBe(false)
    expect(rejection()).toBeUndefined()

    const pay = screen.getByRole("button", { name: /pay/i })
    await waitFor(() => expect(pay).toBeEnabled())
    await userEvent.click(pay)
    await act(() => execution)
    expect(isResolved()).toBe(true)
    expect(stripe.confirmPayment).toHaveBeenCalledTimes(2)
    expect(stripe.elementsProps.every((p) => p.options?.clientSecret === next.clientSecret)).toBe(true)
  })

  it("STR-9: Stripe.js is loaded once per publishable key, not on every render", async () => {
    stripe.confirmPayment.mockResolvedValue({ paymentIntent: { id: "pi_fake_0001", status: "succeeded" } })
    const key = "pk_test_memo_check_00000000000"
    const { execution } = setup(key)
    await screen.findByTestId("payment-element")
    await userEvent.click(screen.getByRole("button", { name: /pay/i }))
    await act(() => execution)
    expect(stripe.loadStripe.mock.calls.filter(([k]) => k === key)).toHaveLength(1)
  })
})

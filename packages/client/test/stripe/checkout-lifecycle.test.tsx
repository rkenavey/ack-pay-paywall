import { act, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { ReactNode } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { PaymentView } from "@paywall/protocol"
import { fixtures, PAYMENT_SERVICE_URL } from "@paywall/testkit"

const stripe = vi.hoisted(() => ({
  loadStripe: vi.fn(),
  confirmPayment: vi.fn(),
  retrievePaymentIntent: vi.fn(),
  elements: { id: "elements-instance" },
}))

vi.mock("@stripe/stripe-js", () => ({ loadStripe: stripe.loadStripe }))
vi.mock("@stripe/react-stripe-js", () => ({
  Elements: (props: { children?: ReactNode }) => <div data-testid="stripe-elements">{props.children}</div>,
  PaymentElement: () => <div data-testid="payment-element" />,
  useStripe: () => ({ confirmPayment: stripe.confirmPayment, retrievePaymentIntent: stripe.retrievePaymentIntent }),
  useElements: () => stripe.elements,
}))

const { createStripeCheckout, StripePaymentForm } = await import("../../src/stripe/index.tsx")

const next = { type: "stripe_payment_element" as const, clientSecret: "pi_fake_0001_secret_fixture1", publishableKey: "pk_test_lifecycle_000000000000" }
const payment: PaymentView = {
  paymentId: "pay_0001",
  status: "requires_payment",
  paymentRequestId: "pr_0001",
  paymentOptionId: "stripe-usd",
  network: "stripe",
  amount: { amount: 500, decimals: 2, currency: "USD" },
  payer: fixtures.client.did,
  payee: fixtures.acme.did,
  policy: { outcome: "allow", rule: "within_limits" },
  next,
}

beforeEach(() => {
  stripe.loadStripe.mockReset().mockResolvedValue({})
  stripe.confirmPayment.mockReset()
  stripe.retrievePaymentIntent.mockReset()
})

function start(signal = new AbortController().signal) {
  const checkout = createStripeCheckout({ returnUrl: "http://localhost:5173/" })
  render(<StripePaymentForm checkout={checkout} />)
  const execution = checkout.executor.execute({ payment, next, paymentServiceUrl: PAYMENT_SERVICE_URL, fetch, signal })
  return { checkout, execution }
}

describe("Stripe checkout lifecycle", () => {
  it("renders nothing until a payment is waiting", () => {
    const checkout = createStripeCheckout({ returnUrl: "http://localhost:5173/" })
    const { container } = render(<StripePaymentForm checkout={checkout} />)
    expect(container).toBeEmptyDOMElement()
    expect(checkout.getSnapshot().status).toBe("idle")
  })

  it("rejects a next action that is not the Payment Element", async () => {
    const checkout = createStripeCheckout({ returnUrl: "http://localhost:5173/" })
    await expect(
      checkout.executor.execute({ payment, next: { type: "sandbox_settle" }, paymentServiceUrl: PAYMENT_SERVICE_URL, fetch, signal: new AbortController().signal }),
    ).rejects.toThrow(/sandbox_settle/)
  })

  it("aborting the run rejects the executor and unmounts the element", async () => {
    const controller = new AbortController()
    const { checkout, execution } = start(controller.signal)
    await screen.findByTestId("payment-element")
    const outcome = execution.then(() => "resolved", (error: unknown) => (error instanceof Error ? error.message : "rejected"))
    act(() => controller.abort())
    expect(await outcome).toMatch(/aborted/)
    expect(checkout.getSnapshot().status).toBe("idle")
    expect(screen.queryByTestId("payment-element")).toBeNull()
  })

  it("waits while Stripe reports the payment as processing, and resolves once it succeeds", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      stripe.confirmPayment.mockResolvedValue({ paymentIntent: { id: "pi_fake_0001", status: "processing" } })
      stripe.retrievePaymentIntent.mockResolvedValue({ paymentIntent: { id: "pi_fake_0001", status: "succeeded" } })
      const { checkout, execution } = start()
      await screen.findByTestId("payment-element")
      await userEvent.click(screen.getByRole("button", { name: /pay/i }))
      expect(await screen.findByText(/still processing/i)).toBeInTheDocument()
      await act(() => vi.advanceTimersByTimeAsync(2000))
      await act(() => execution)
      expect(stripe.retrievePaymentIntent).toHaveBeenCalledWith(next.clientSecret)
      expect(checkout.getSnapshot().status).toBe("succeeded")
    } finally {
      vi.useRealTimers()
    }
  })
})

import * as v from "valibot"
import { expect, vi } from "vitest"
import { errorBodySchema, paymentViewSchema, type Money, type PaymentView } from "@paywall/protocol"
import {
  APPROVER_TOKEN,
  buildInitiation,
  buildPaymentRequest,
  FakeStripeGateway,
  FAKE_STRIPE_KEYS,
  fixtureResolver,
  fixtures,
  MemoryEventLog,
  paymentOption,
  PAYMENT_SERVICE_URL,
  SequenceIds,
  useFixedTime,
  type FixtureIdentity,
} from "@paywall/testkit"
import {
  createMemoryApprovalStore,
  createMemoryPaymentStore,
  createPaymentService,
  createSandboxAdapter,
  createStripeAdapter,
  evaluateSpend,
  type SettlementAdapter,
  type SpendPolicyConfig,
  type SpendRequest,
} from "../../src/index.ts"

/** The receipt lifetime the payment service tests configure, in seconds. */
export const RECEIPT_TTL_SECONDS = 600

/** The policy the payment service tests use: Acme allowed, approval above $50.00. */
export const policyConfig: SpendPolicyConfig = {
  allowedCounterparties: [fixtures.acme.did],
  approvalThreshold: { amount: 5000, decimals: 2, currency: "USD" },
}

/**
 * A payment service on a fixed clock with the real policy, the sandbox
 * adapter and, when asked, the Stripe adapter over a fake gateway. Adapter
 * methods are spied on so tests can count settlement starts.
 */
export function setupPaymentService(options: { stripe?: boolean; webhookConfigured?: boolean; fakeTimers?: boolean } = {}) {
  const clock = useFixedTime(undefined, { fakeTimers: options.fakeTimers ?? false })
  const ids = new SequenceIds()
  const log = new MemoryEventLog(clock)
  const payments = createMemoryPaymentStore()
  const approvals = createMemoryApprovalStore()
  const policyCalls: SpendRequest[] = []
  const policy = (request: SpendRequest) => {
    policyCalls.push(structuredClone(request))
    return evaluateSpend(request, policyConfig)
  }

  const sandbox = createSandboxAdapter()
  const adapters: SettlementAdapter[] = [sandbox]
  const gateway = new FakeStripeGateway()
  let stripe: SettlementAdapter | undefined
  if (options.stripe) {
    stripe = createStripeAdapter({ gateway, publishableKey: FAKE_STRIPE_KEYS.publishableKey })
    adapters.push(stripe)
  }
  const begin = adapters.map((adapter) => vi.spyOn(adapter, "begin"))
  const verify = adapters.map((adapter) => vi.spyOn(adapter, "verify"))

  const app = createPaymentService({
    identity: fixtures.paymentService,
    publicUrl: PAYMENT_SERVICE_URL,
    policy,
    adapters,
    payments,
    approvals,
    approverToken: APPROVER_TOKEN,
    receiptTtlSeconds: RECEIPT_TTL_SECONDS,
    ...(options.stripe ? { stripe: { gateway, webhookConfigured: options.webhookConfigured ?? true } } : {}),
    resolver: fixtureResolver(),
    clock,
    ids,
    log,
  })

  /** How many times any adapter's `begin` ran. */
  const beginCalls = () => begin.reduce((sum, spy) => sum + spy.mock.calls.length, 0)

  /** A payment request signed by `issuer` (Acme) offering sandbox and stripe options for `amount`. */
  async function request(o: { amount?: number; issuer?: FixtureIdentity; expiresInMs?: number; id?: string; description?: string } = {}) {
    const issuer = o.issuer ?? fixtures.acme
    const amount = o.amount ?? 500
    return buildPaymentRequest({
      now: clock.now(),
      issuer,
      id: o.id ?? "pr_0001",
      description: o.description ?? "Market brief",
      expiresAt: new Date(clock.now().getTime() + (o.expiresInMs ?? 900_000)),
      paymentOptions: [
        paymentOption({ network: "sandbox", amount, recipient: issuer.did }),
        paymentOption({ network: "stripe", amount, recipient: issuer.did }),
      ],
    })
  }

  async function post(path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
    return app.request(path, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    })
  }

  /** POSTs an initiation for the token and option. */
  async function initiate(paymentRequestToken: string, paymentOptionId = "sandbox-usd", extra: Parameters<typeof buildInitiation>[0] = {}) {
    const initiation = await buildInitiation({ paymentRequestToken, paymentOptionId, ...extra })
    return post("/payments", { initiation })
  }

  const getPayment = (id: string) => app.request(`/payments/${id}`)
  const settle = (id: string) => post(`/payments/${id}/sandbox/settle`, {})
  const receipt = (id: string) => post(`/payments/${id}/receipt`, {})

  return { app, clock, ids, log, payments, approvals, policyCalls, sandbox, stripe, gateway, begin, verify, beginCalls, request, post, initiate, getPayment, settle, receipt }
}

/** Reads and validates a PaymentView, asserting the status code. */
export async function expectView(response: Response, status: number): Promise<PaymentView> {
  const raw = await response.json()
  expect(response.status, JSON.stringify(raw)).toBe(status)
  const parsed = v.safeParse(paymentViewSchema, raw)
  expect(parsed.issues).toBeUndefined()
  return parsed.output as PaymentView
}

/** Asserts an error body with the given status and code, and returns its details. */
export async function expectError(response: Response, status: number, code: string): Promise<Record<string, unknown> | undefined> {
  const raw = await response.json()
  expect(response.status, JSON.stringify(raw)).toBe(status)
  const body = v.parse(errorBodySchema, raw)
  expect(body.error.code).toBe(code)
  return body.error.details
}

/** US dollars in cents. */
export const usd = (amount: number): Money => ({ amount, decimals: 2, currency: "USD" })

import {
  createPaymentReceipt,
  signCredential,
  verifyJwt,
  verifyPaymentRequestToken,
  type JwtString,
  type PaymentOption,
  type PaymentRequest,
} from "agentcommercekit"
import { Hono, type Context } from "hono"
import * as v from "valibot"
import {
  didSchema,
  formatMoney,
  initiatePaymentBodySchema,
  MAX_INITIATION_LIFETIME_SECONDS,
  paymentInitiationClaimsSchema,
  policyDecisionSchema,
  tokenTail,
  type DidUri,
  type ErrorBody,
  type EventLog,
  type Money,
  type Network,
  type NextAction,
  type PaymentServiceErrorCode,
  type PaymentView,
  type PolicyDecision,
  type ReceiptBody,
} from "@paywall/protocol"
import { createApproverRoutes } from "./approvals/index.ts"
import type {
  PaymentRecord,
  PaymentServiceDeps,
  SandboxAdapter,
  SettlementAdapter,
  SettlementResult,
  StripeAdapter,
  StripeGateway,
} from "./types.ts"

/** The payment service types: payments, stores, settlement adapters, the Stripe gateway seam and approvals. */
export type * from "./types.ts"

type ContentfulStatus = 400 | 401 | 403 | 404 | 409 | 410 | 500 | 503

class Refusal extends Error {
  readonly status: ContentfulStatus
  readonly code: PaymentServiceErrorCode | "internal_error"
  readonly details: Record<string, unknown> | undefined
  constructor(status: ContentfulStatus, code: PaymentServiceErrorCode | "internal_error", message: string, details?: Record<string, unknown>) {
    super(message)
    this.status = status
    this.code = code
    this.details = details
  }
}

/** What `settle` found: the payment as it now is, or why it is not settled. */
type SettleOutcome = { ok: true; payment: PaymentRecord } | { ok: false; refusal: Refusal }

const notFound = () => new Refusal(404, "payment_not_found", "No such payment.")

/**
 * The public form of a payment record. `next` is shown only while the
 * payment can be paid and `failure` only once it has failed.
 */
function toView(record: PaymentRecord): PaymentView {
  return {
    paymentId: record.id,
    status: record.status,
    paymentRequestId: record.paymentRequestId,
    paymentOptionId: record.paymentOptionId,
    network: record.network,
    amount: { ...record.amount },
    ...(record.description === undefined ? {} : { description: record.description }),
    payer: record.payer,
    payee: record.payee,
    policy: structuredClone(record.policy),
    ...(record.approvalId === undefined ? {} : { approvalId: record.approvalId }),
    ...(record.status === "requires_payment" && record.next ? { next: structuredClone(record.next) } : {}),
    ...(record.status === "failed" ? { failure: record.failure ?? "The payment failed." } : {}),
  }
}

/**
 * The public form of a payment, for a response. A payment in
 * `requires_payment` with no next action (settlement never started, and the
 * cancel of what it may have created is still outstanding) cannot be shown
 * without breaking the wire contract, so it answers `500` instead.
 */
function view(record: PaymentRecord): PaymentView {
  if (record.status === "requires_payment" && !record.next) {
    throw new Refusal(500, "internal_error", "Settlement for this payment could not be started; it cannot be paid.")
  }
  return toView(record)
}

function isSandboxAdapter(adapter: SettlementAdapter | undefined): adapter is SandboxAdapter {
  return adapter?.network === "sandbox" && typeof (adapter as Partial<SandboxAdapter>).markPaid === "function"
}

function isStripeAdapter(adapter: SettlementAdapter | undefined): adapter is StripeAdapter {
  return adapter?.network === "stripe" && typeof (adapter as Partial<StripeAdapter>).cancel === "function"
}

/**
 * Builds the payment service, which is also the receipt service.
 *
 * It verifies signed payment initiations, applies the spend policy before any
 * money moves, holds payments that need a human, drives settlement through
 * the adapters, and signs a `PaymentReceiptCredential` only after it has
 * verified settlement itself. Mount the returned app under `/payment-service`.
 *
 * Amount, currency and payee always come from the verified payment request
 * token. Anything unexpected answers with an error and moves no money.
 */
export function createPaymentService(deps: PaymentServiceDeps): Hono {
  const { identity, publicUrl, payments, approvals, clock, ids, log } = deps
  const adapters = new Map<Network, SettlementAdapter>()
  for (const adapter of deps.adapters) {
    if (adapters.has(adapter.network)) throw new Error(`two settlement adapters for the ${adapter.network} network`)
    adapters.set(adapter.network, adapter)
  }
  const emit = (event: Omit<Parameters<EventLog["emit"]>[0], "actor">) => log.emit({ ...event, actor: "payment-service" })
  // Receipt signing in flight per payment, so concurrent requests share one receipt.
  const issuing = new Map<string, Promise<JwtString>>()
  // Stripe webhook event ids already handled, so a redelivery changes nothing.
  const webhookEvents = new Set<string>()
  // Settlement being started per payment, so failing a payment waits for the PaymentIntent it may create.
  const beginning = new Map<string, Promise<NextAction>>()
  // Payments to fail once their PaymentIntent cancel is confirmed. Each touch of one retries the cancel once.
  const cancelOwed = new Map<string, { failure: string; reason: string }>()

  const app = new Hono()

  app.onError((error, c) => {
    if (error instanceof Refusal) return refuse(c, error)
    return refuse(c, new Refusal(500, "internal_error", "The payment service failed; no payment was made."))
  })

  app.post("/payments", async (c) => {
    const result = await initiate(c)
    return c.json(view(result.payment), result.status)
  })

  app.get("/payments/:id", async (c) => {
    const payment = await payments.get(c.req.param("id"))
    if (!payment) throw notFound()
    return c.json(view(payment))
  })

  app.post("/payments/:id/sandbox/settle", async (c) => {
    const payment = await payments.get(c.req.param("id"))
    if (!payment) throw notFound()
    const sandbox = adapters.get("sandbox")
    if (payment.network !== "sandbox" || payment.status !== "requires_payment" || !isSandboxAdapter(sandbox)) {
      throw new Refusal(409, "payment_not_payable", "Only a sandbox payment that is waiting for payment can be settled here.")
    }
    // Nothing has been paid yet, so an expired request can still be refused safely.
    if (payment.expiresAt && payment.expiresAt.getTime() <= clock.now().getTime()) {
      await fail(payment, "The payment request expired before it was paid.", "expired")
      throw new Refusal(409, "payment_not_payable", "The payment request has expired.")
    }
    await sandbox.markPaid(payment, clock.now())
    const outcome = await settle(payment.id)
    if (!outcome.ok) throw outcome.refusal
    return c.json(toView(outcome.payment))
  })

  app.post("/payments/:id/receipt", async (c) => {
    const id = c.req.param("id")
    const payment = await payments.get(id)
    if (!payment) throw notFound()
    if (payment.status === "requires_payment") {
      const outcome = await settle(id)
      if (!outcome.ok) throw outcome.refusal
    } else {
      await touch(payment)
    }
    const receipt = await receiptFor(id)
    return c.json<ReceiptBody>({ receipt })
  })

  app.post("/webhooks/stripe", async (c) => {
    const stripe = deps.stripe
    if (!stripe?.webhookConfigured) {
      return refuse(c, new Refusal(503, "webhook_not_configured", "The Stripe webhook is not configured."))
    }
    // The signature covers the exact bytes Stripe sent, so read the body raw.
    const rawBody = await c.req.text()
    const signature = c.req.header("Stripe-Signature")
    let event: ReturnType<typeof stripe.gateway.constructWebhookEvent>
    try {
      if (!signature) throw new Error("missing signature")
      event = stripe.gateway.constructWebhookEvent(rawBody, signature)
    } catch {
      throw new Refusal(400, "webhook_signature_invalid", "The webhook signature does not verify.")
    }
    if (webhookEvents.has(event.id)) return c.json({ received: true })
    webhookEvents.add(event.id)
    try {
      await handleStripeEvent(stripe.gateway, event)
    } catch (error) {
      // Let Stripe deliver it again later.
      webhookEvents.delete(event.id)
      throw error
    }
    return c.json({ received: true })
  })

  app.route("/approvals", createApproverRoutes({ deps, begin: startWith, fail, touch, release }))

  // ---------------------------------------------------------------------------

  async function initiate(c: Context): Promise<{ payment: PaymentRecord; status: 200 | 201 | 202 }> {
    const now = clock.now()

    // 1. The initiation: signed by the payer, for us, short-lived.
    const invalid = (message: string) => new Refusal(400, "invalid_initiation", message)
    let raw: unknown
    try {
      raw = await c.req.json()
    } catch {
      throw invalid("The body must be JSON with an initiation JWT.")
    }
    const body = v.safeParse(initiatePaymentBodySchema, raw)
    if (!body.success) throw invalid("The body must carry an initiation JWT.")
    let verified: Awaited<ReturnType<typeof verifyJwt>>
    try {
      verified = await verifyJwt(body.output.initiation, { resolver: deps.resolver, audience: publicUrl })
    } catch {
      throw invalid("The initiation JWT does not verify for this payment service.")
    }
    const { payload } = verified
    const audience = Array.isArray(payload.aud) && payload.aud.length === 1 ? payload.aud[0] : payload.aud
    if (audience !== publicUrl) throw invalid("The initiation is addressed to another service.")
    if (typeof payload.iat !== "number" || typeof payload.exp !== "number") throw invalid("The initiation must carry iat and exp.")
    if (payload.exp - payload.iat > MAX_INITIATION_LIFETIME_SECONDS || payload.exp <= payload.iat) {
      throw invalid(`The initiation must expire within ${MAX_INITIATION_LIFETIME_SECONDS} seconds of being issued.`)
    }
    if (payload.exp * 1000 <= now.getTime()) throw invalid("The initiation has expired.")
    const claims = v.safeParse(paymentInitiationClaimsSchema, payload)
    if (!claims.success) throw invalid("The initiation must carry paymentRequestToken and paymentOptionId.")
    if (!v.is(didSchema, verified.issuer)) throw invalid("The initiation issuer is not a DID.")
    const payer: DidUri = verified.issuer
    const { paymentRequestToken, paymentOptionId } = claims.output
    emit({ name: "ps.payment.initiated", data: { payer, option: paymentOptionId, initiation: tokenTail(body.output.initiation) } })

    // 2. The payment request: signed by the payee, still payable.
    let paymentRequest: PaymentRequest
    let payee: DidUri
    try {
      const result = await verifyPaymentRequestToken(paymentRequestToken, { resolver: deps.resolver })
      paymentRequest = result.paymentRequest
      if (!v.is(didSchema, result.parsed.issuer)) throw new Error("issuer is not a DID")
      payee = result.parsed.issuer
    } catch {
      throw new Refusal(400, "payment_request_invalid", "The payment request token does not verify.")
    }
    let expiresAt: Date | undefined
    if (paymentRequest.expiresAt !== undefined) {
      expiresAt = new Date(paymentRequest.expiresAt)
      if (Number.isNaN(expiresAt.getTime())) throw new Refusal(400, "payment_request_invalid", "The payment request has an unreadable expiry.")
      if (expiresAt.getTime() <= now.getTime()) throw new Refusal(410, "payment_request_expired", "The payment request has expired.")
    }

    // 3. The option: one we can settle and sign the receipt for.
    const option = paymentRequest.paymentOptions.find((candidate) => candidate.id === paymentOptionId)
    if (!option) throw new Refusal(400, "payment_option_unknown", `The payment request has no option "${paymentOptionId}".`)
    const { network, amount } = supported(option)

    // 4. A repeat returns the payment already started, whatever its state.
    const existing = await payments.findByKey(payer, paymentRequest.id, option.id)
    if (existing) return repeat(existing, payee)

    // 5. The policy, before any money moves.
    const spend = {
      payer,
      counterparty: payee,
      amount,
      paymentRequestId: paymentRequest.id,
      ...(paymentRequest.description === undefined ? {} : { description: paymentRequest.description }),
    }
    const decision = evaluate(spend)
    const paymentId = decision.outcome === "deny" ? undefined : ids.next("pay")
    emit({
      name: "ps.policy.evaluated",
      paymentRequestId: paymentRequest.id,
      ...(paymentId === undefined ? {} : { paymentId }),
      data: { outcome: decision.outcome, rule: decision.rule, amount: formatMoney(amount), payer, counterparty: payee },
    })

    // 6. Deny: nothing is stored and no adapter is called.
    if (decision.outcome === "deny" || paymentId === undefined) {
      throw new Refusal(403, "policy_denied", "The spend policy does not allow this payment.", { rule: decision.rule })
    }

    const record: PaymentRecord = {
      id: paymentId,
      status: decision.outcome === "needs_approval" ? "pending_approval" : "requires_payment",
      paymentRequestId: paymentRequest.id,
      paymentRequestToken,
      paymentOptionId: option.id,
      network,
      amount,
      ...(paymentRequest.description === undefined ? {} : { description: paymentRequest.description }),
      payer,
      payee,
      ...(expiresAt === undefined ? {} : { expiresAt }),
      policy: decision,
    }

    // 7. Needs approval: hold the payment for a human. No adapter is called.
    if (decision.outcome === "needs_approval") {
      const approvalId = ids.next("apr")
      const stored = await store({ ...record, approvalId })
      if (stored !== true) return repeat(stored, payee)
      await approvals.create({ id: approvalId, paymentId, status: "pending", requestedAt: now })
      emit({
        name: "ps.approval.requested",
        paymentRequestId: paymentRequest.id,
        paymentId,
        data: { approvalId, amount: formatMoney(amount), threshold: formatMoney(decision.threshold) },
      })
      return { payment: (await payments.get(paymentId)) ?? { ...record, approvalId }, status: 202 }
    }

    // 8. Allow: store it, then start settlement.
    const stored = await store(record)
    if (stored !== true) return repeat(stored, payee)
    const begun = await begin(record)
    // 201 promises a payment that can be paid; one that failed, or whose cancel is outstanding, stays stored for repeats.
    if (begun.status !== "requires_payment" || !begun.next) throw new Refusal(500, "internal_error", "Settlement could not be started; the payment failed.")
    return { payment: begun, status: 201 }
  }

  /** Checks the option is one this service settles, and reads its amount. */
  function supported(option: PaymentOption): { network: Network; amount: Money } {
    const unsupported = (message: string) => new Refusal(400, "payment_option_unsupported", message)
    if (option.paymentService !== publicUrl) throw unsupported("The option names another payment service.")
    if (option.receiptService !== identity.did) throw unsupported("The option names another receipt service.")
    const network = option.network as Network
    if (typeof option.network !== "string" || !adapters.has(network)) throw unsupported(`The ${String(option.network)} network is not supported here.`)
    if (typeof option.amount !== "number" || !Number.isSafeInteger(option.amount) || option.amount <= 0) {
      throw unsupported("The option amount must be a positive whole number of minor units.")
    }
    return { network, amount: { amount: option.amount, decimals: option.decimals, currency: option.currency } }
  }

  /** Runs the policy, failing closed when it throws or answers something unknown. */
  function evaluate(request: Parameters<PaymentServiceDeps["policy"]>[0]): PolicyDecision {
    let decision: unknown
    try {
      decision = deps.policy(request)
    } catch {
      throw new Refusal(500, "internal_error", "The spend policy failed; no payment was made.")
    }
    if (!v.is(policyDecisionSchema, decision)) throw new Refusal(500, "internal_error", "The spend policy gave no usable decision; no payment was made.")
    return decision
  }

  /** Answers a repeated initiation with the payment already started. */
  function repeat(existing: PaymentRecord, payee: DidUri): { payment: PaymentRecord; status: 200 } {
    // Request ids are only unique per issuer; never hand one payee's payment to another's request.
    if (existing.payee !== payee) throw new Refusal(400, "payment_request_invalid", "A different payment request with this id was already used.")
    return { payment: existing, status: 200 }
  }

  /** Stores a new payment, or returns the one a concurrent initiation stored first. */
  async function store(record: PaymentRecord): Promise<true | PaymentRecord> {
    try {
      await payments.create(record)
      return true
    } catch (error) {
      const winner = await payments.findByKey(record.payer, record.paymentRequestId, record.paymentOptionId)
      if (winner) return winner
      throw error
    }
  }

  /** Starts settlement for a payment in `requires_payment` and records its next action. */
  async function begin(record: PaymentRecord): Promise<PaymentRecord> {
    let next
    try {
      next = await startWith(record)
    } catch {
      return fail(record, "Settlement could not be started.")
    }
    if (await payments.transition(record.id, "requires_payment", { status: "requires_payment", next })) {
      emit({ name: "ps.settlement.started", paymentRequestId: record.paymentRequestId, paymentId: record.id, data: { network: record.network, next: next.type } })
    } else {
      // The payment stopped being payable while settlement was starting.
      await release(record)
    }
    return (await payments.get(record.id)) ?? { ...record, next }
  }

  /**
   * Calls the payment's adapter `begin`, the only place money movement
   * starts, and records the call as in flight until it settles. Throws when
   * the network has no adapter or `begin` fails.
   */
  async function startWith(record: PaymentRecord): Promise<NextAction> {
    const adapter = adapters.get(record.network)
    if (!adapter) throw new Error(`no adapter for the ${record.network} network`)
    const started = adapter.begin(record)
    beginning.set(record.id, started)
    try {
      return await started
    } finally {
      if (beginning.get(record.id) === started) beginning.delete(record.id)
    }
  }

  /**
   * Moves a payment that has not settled to `failed`. A Stripe payment moves
   * only once its PaymentIntent cancel is confirmed, so a failed payment can
   * never capture money later.
   *
   * When the cancel is refused or errors, the payment keeps its status, the
   * failure is owed, and `ps.settlement.failed` is logged with
   * `reason=cancel_failed`; the next touch of the payment tries the cancel
   * once more. A PaymentIntent that cannot be cancelled because it has
   * succeeded wins: the payment is settled instead. Never throws for a
   * cancel or verify error.
   */
  async function fail(record: PaymentRecord, failure: string, reason = "failed"): Promise<PaymentRecord> {
    // A PaymentIntent being created now must exist before it can be cancelled.
    await beginning.get(record.id)?.catch(() => undefined)
    const current = (await payments.get(record.id)) ?? record
    const from = current.status
    if (from !== "requires_payment" && from !== "pending_approval") {
      cancelOwed.delete(current.id)
      return current
    }
    const adapter = adapters.get(current.network)
    if (isStripeAdapter(adapter)) {
      try {
        await adapter.cancel(current)
      } catch {
        if (from === "requires_payment") {
          let result: SettlementResult | undefined
          try {
            result = await adapter.verify(current)
          } catch {
            result = undefined
          }
          if (result?.settled && (await confirm(current, result))) return (await payments.get(current.id)) ?? current
        }
        cancelOwed.set(current.id, { failure, reason })
        emit({
          name: "ps.settlement.failed",
          paymentRequestId: current.paymentRequestId,
          paymentId: current.id,
          data: { network: current.network, reason: "cancel_failed", cause: reason },
        })
        return (await payments.get(current.id)) ?? current
      }
    }
    cancelOwed.delete(current.id)
    if (await payments.transition(current.id, from, { status: "failed", failure, next: undefined })) {
      emit({ name: "ps.settlement.failed", paymentRequestId: current.paymentRequestId, paymentId: current.id, data: { network: current.network, reason } })
    }
    return (await payments.get(current.id)) ?? current
  }

  /**
   * Retries an outstanding PaymentIntent cancel, once, for a payment that is
   * owed a failure. Does nothing for any other payment. Called by every route
   * that touches a payment: settle, the receipt route, the webhook and the
   * approver routes.
   */
  async function touch(record: PaymentRecord): Promise<PaymentRecord> {
    const owed = cancelOwed.get(record.id)
    return owed ? fail(record, owed.failure, owed.reason) : record
  }

  /** Cancels whatever settlement was started for a payment that is no longer payable. */
  async function release(record: PaymentRecord): Promise<void> {
    const current = (await payments.get(record.id)) ?? record
    if (current.status !== "failed" && current.status !== "rejected") return
    const adapter = adapters.get(current.network)
    if (!isStripeAdapter(adapter)) return
    try {
      await adapter.cancel(current)
    } catch {
      emit({
        name: "ps.settlement.failed",
        paymentRequestId: current.paymentRequestId,
        paymentId: current.id,
        data: { network: current.network, reason: "cancel_failed" },
      })
    }
  }

  /**
   * Checks settlement with the payment's adapter and, when the money has
   * arrived, moves the payment to `settled` with one compare-and-set. Called
   * by the receipt route, the sandbox settle route and the Stripe webhook.
   */
  async function settle(paymentId: string): Promise<SettleOutcome> {
    const payment = await payments.get(paymentId)
    if (!payment) return { ok: false, refusal: notFound() }
    if (payment.status === "settled") return { ok: true, payment }
    const notSettled = new Refusal(409, "payment_not_settled", "The payment has not settled.")
    if (payment.status !== "requires_payment") return { ok: false, refusal: notSettled }
    const adapter = adapters.get(payment.network)
    if (!adapter) return { ok: false, refusal: notSettled }

    let result: SettlementResult
    try {
      result = await adapter.verify(payment)
    } catch {
      // A confirmed cancel proves the PaymentIntent had not succeeded, so retrying an owed one needs no verify.
      await touch(payment)
      return { ok: false, refusal: notSettled }
    }
    if (result.settled) {
      await confirm(payment, result)
      const now = await payments.get(paymentId)
      return now?.status === "settled" ? { ok: true, payment: now } : { ok: false, refusal: notSettled }
    }
    if (result.reason === "mismatch") {
      emit({ name: "ps.settlement.failed", paymentRequestId: payment.paymentRequestId, paymentId, data: { network: payment.network, reason: "mismatch" } })
      return { ok: false, refusal: new Refusal(409, "settlement_mismatch", "The settlement does not match the payment; no receipt was issued.") }
    }
    // At most one fail, so one cancel attempt, per call.
    const owed = cancelOwed.get(paymentId)
    let after: PaymentRecord | undefined
    if (result.reason === "failed") after = await fail(payment, result.detail ?? "The payment failed.")
    else if (owed) after = await fail(payment, owed.failure, owed.reason)
    // Settlement that arrived is honoured above; one that has not arrived by the expiry never will.
    else if (payment.expiresAt && payment.expiresAt.getTime() <= clock.now().getTime()) {
      after = await fail(payment, "The payment request expired before it was paid.", "expired")
    }
    // A PaymentIntent that succeeded while its cancel was refused settled the payment instead.
    if (after?.status === "settled") return { ok: true, payment: after }
    return { ok: false, refusal: notSettled }
  }

  /** Moves a payment from `requires_payment` to `settled` with one compare-and-set; true for the caller that moved it. */
  async function confirm(payment: PaymentRecord, result: Extract<SettlementResult, { settled: true }>): Promise<boolean> {
    const settlement = { ref: result.ref, settledAt: result.settledAt }
    if (!(await payments.transition(payment.id, "requires_payment", { status: "settled", next: undefined, settlement }))) return false
    cancelOwed.delete(payment.id)
    emit({
      name: "ps.settlement.confirmed",
      paymentRequestId: payment.paymentRequestId,
      paymentId: payment.id,
      data: { network: payment.network, ref: result.ref, amount: formatMoney(payment.amount), settledAt: result.settledAt.toISOString() },
    })
    return true
  }

  /**
   * Acts on a verified Stripe event. The event only says where to look: the
   * PaymentIntent is retrieved from Stripe, and `settle` verifies it again
   * through the adapter before anything moves to `settled`.
   */
  async function handleStripeEvent(gateway: StripeGateway, event: { type: string; paymentIntentId?: string }): Promise<void> {
    if (event.type !== "payment_intent.succeeded" && event.type !== "payment_intent.payment_failed") return
    if (!event.paymentIntentId) return
    const intent = await gateway.retrievePaymentIntent(event.paymentIntentId)
    const paymentId = intent.metadata.paymentId
    if (!paymentId) return
    const payment = await payments.get(paymentId)
    if (!payment || payment.network !== "stripe") return
    const failed = (reason: string) =>
      emit({ name: "ps.settlement.failed", paymentRequestId: payment.paymentRequestId, paymentId, data: { network: "stripe", reason, paymentIntent: intent.id } })
    if (event.type === "payment_intent.succeeded") {
      // settle verifies first, so a PaymentIntent that succeeded wins over a cancel that is still owed.
      if (payment.status === "requires_payment") await settle(paymentId)
      else await touch(payment)
      return
    }
    // A decline is not final: the payer can try again on the same PaymentIntent, so the payment stays payable.
    // Events can arrive out of order, so a PaymentIntent that has since succeeded is left to the success path.
    if (payment.status === "requires_payment" && intent.status !== "succeeded" && !cancelOwed.has(paymentId)) failed("declined")
    else await touch(payment)
  }

  /** Signs the receipt for a settled payment once, and returns the same JWT every time after. */
  async function receiptFor(paymentId: string): Promise<JwtString> {
    const payment = await payments.get(paymentId)
    if (!payment) throw notFound()
    const { settlement } = payment
    if (payment.status !== "settled" || !settlement) throw new Refusal(409, "payment_not_settled", "The payment has not settled.")
    if (payment.receipt) return payment.receipt
    let pending = issuing.get(paymentId)
    if (!pending) {
      pending = issue(payment, settlement).finally(() => issuing.delete(paymentId))
      issuing.set(paymentId, pending)
    }
    return pending
  }

  async function issue(payment: PaymentRecord, settlement: NonNullable<PaymentRecord["settlement"]>): Promise<JwtString> {
    const expirationDate = new Date(settlement.settledAt.getTime() + deps.receiptTtlSeconds * 1000)
    const credential = createPaymentReceipt({
      paymentRequestToken: payment.paymentRequestToken,
      paymentOptionId: payment.paymentOptionId,
      issuer: identity.did,
      payerDid: payment.payer,
      expirationDate,
      metadata: {
        paymentId: payment.id,
        paymentRequestId: payment.paymentRequestId,
        network: payment.network,
        amount: payment.amount.amount,
        decimals: payment.amount.decimals,
        currency: payment.amount.currency,
        payee: payment.payee,
        settlementRef: settlement.ref,
        settledAt: settlement.settledAt.toISOString(),
      },
    })
    const receipt = await signCredential(credential, { did: identity.did, signer: identity.signer, alg: identity.alg })
    if (!(await payments.transition(payment.id, "settled", { status: "settled", receipt }))) {
      throw new Refusal(409, "payment_not_settled", "The payment is no longer settled.")
    }
    emit({
      name: "ps.receipt.issued",
      paymentRequestId: payment.paymentRequestId,
      paymentId: payment.id,
      data: { payer: payment.payer, option: payment.paymentOptionId, expiresAt: expirationDate.toISOString(), receipt: tokenTail(receipt) },
    })
    return receipt
  }

  function refuse(c: Context, refusal: Refusal): Response {
    const body: ErrorBody = {
      error: { code: refusal.code, message: refusal.message, ...(refusal.details === undefined ? {} : { details: refusal.details }) },
    }
    return c.json(body, refusal.status)
  }

  return app
}

/**
 * Creates the sandbox settlement adapter: `begin` asks the client to call the
 * sandbox settle route, and `verify` reads an in-memory ledger. No real money
 * moves.
 *
 * `verify` reports a payment settled only when the ledger holds it for the
 * same amount and currency, with `sandbox_<paymentId>` as the settlement
 * reference.
 */
export function createSandboxAdapter(): SandboxAdapter {
  const ledger = new Map<string, { amount: Money; paidAt: Date }>()
  return {
    network: "sandbox",
    async begin() {
      return { type: "sandbox_settle" }
    },
    async markPaid(payment, at) {
      if (!ledger.has(payment.id)) ledger.set(payment.id, { amount: { ...payment.amount }, paidAt: new Date(at.getTime()) })
    },
    async verify(payment) {
      const entry = ledger.get(payment.id)
      if (!entry) return { settled: false, reason: "pending" }
      const { amount } = entry
      if (amount.amount !== payment.amount.amount || amount.currency !== payment.amount.currency || amount.decimals !== payment.amount.decimals) {
        return { settled: false, reason: "mismatch", detail: "the ledger amount differs from the payment" }
      }
      return { settled: true, ref: `sandbox_${payment.id}`, settledAt: new Date(entry.paidAt.getTime()) }
    },
  }
}

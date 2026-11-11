import { isJwtString, type DidUri, type JwtString, type PaymentRequest } from "agentcommercekit"
import { didUriSchema, paymentRequestSchema } from "agentcommercekit/schemas/valibot"
import * as v from "valibot"
import { isPositiveSafeInteger, type Money } from "./money.ts"

/** The request header that carries a receipt (a VC-JWT) when a client retries a paywalled request. */
export const RECEIPT_HEADER = "Payment-Receipt"

/** The `PaymentOption.network` values this paywall issues. */
export type Network = "sandbox" | "stripe"

/** Every {@link Network}, in the order a client prefers them by default. */
export const NETWORKS = ["stripe", "sandbox"] as const satisfies readonly Network[]

/**
 * The body of every error response.
 *
 * `code` is machine-readable and stable; `message` is for people; `details`
 * carries structured context such as the policy rule that denied a payment.
 */
export interface ErrorBody<C extends string = string> {
  error: { code: C; message: string; details?: Record<string, unknown> }
}

/** Why a server agent rejected a presented receipt. */
export type ReceiptErrorCode =
  | "receipt_invalid"
  | "receipt_untrusted_issuer"
  | "receipt_expired"
  | "receipt_wrong_resource"
  | "receipt_already_redeemed"

/** Every {@link ReceiptErrorCode}. */
export const RECEIPT_ERROR_CODES = [
  "receipt_invalid",
  "receipt_untrusted_issuer",
  "receipt_expired",
  "receipt_wrong_resource",
  "receipt_already_redeemed",
] as const satisfies readonly ReceiptErrorCode[]

/** Error codes a server agent answers with, other than the receipt codes carried in a 402. */
export type ServerAgentErrorCode = "resource_not_found"

/** Error codes the payment service answers with. */
export type PaymentServiceErrorCode =
  | "invalid_initiation"
  | "payment_request_invalid"
  | "payment_option_unknown"
  | "payment_option_unsupported"
  | "policy_denied"
  | "payment_request_expired"
  | "payment_not_found"
  | "payment_not_payable"
  | "payment_not_settled"
  | "settlement_mismatch"
  | "webhook_signature_invalid"
  | "webhook_not_configured"
  | "unauthorized"
  | "invalid_request"
  | "approval_not_found"
  | "approval_already_decided"

/**
 * The body of a `402 Payment Required` answer.
 *
 * `paymentRequestToken` is the signed form of `paymentRequest`; clients trust
 * only the token. `error` is absent on a first request; when a presented
 * receipt was rejected it says why, and the body carries a fresh request.
 */
export interface PaymentRequiredBody {
  paymentRequest: PaymentRequest
  paymentRequestToken: JwtString
  error?: ErrorBody<ReceiptErrorCode>["error"]
}

/** A paywalled resource as the free catalog route lists it. */
export interface ResourceSummary {
  id: string
  title: string
  price: Money
}

/** The body of `GET /resources`. */
export interface ResourceListBody {
  resources: ResourceSummary[]
}

/** A delivered resource. */
export interface ResourceBody {
  id: string
  title: string
  content: string
}

/** The body of `POST {paymentService}/payments`: a signed initiation JWT. */
export interface InitiatePaymentBody {
  initiation: JwtString
}

/**
 * The private claims of the initiation JWT.
 *
 * The registered claims carry the rest: `iss` is the payer DID, `aud` the
 * option's `paymentService` URL, and `exp` is at most 300 seconds after `iat`.
 * Nothing else in the initiation is trusted: amount, currency and payee come
 * from the verified payment request token.
 */
export interface PaymentInitiationClaims {
  paymentRequestToken: JwtString
  paymentOptionId: string
}

/** The longest an initiation JWT may live, in seconds from `iat` to `exp`. */
export const MAX_INITIATION_LIFETIME_SECONDS = 300

/** Where a payment is in its lifecycle. */
export type PaymentStatus = "pending_approval" | "rejected" | "requires_payment" | "settled" | "failed"

/** Every {@link PaymentStatus}. */
export const PAYMENT_STATUSES = [
  "pending_approval",
  "rejected",
  "requires_payment",
  "settled",
  "failed",
] as const satisfies readonly PaymentStatus[]

/**
 * What the client must do to pay, given by the payment service once a payment
 * may proceed.
 *
 * `clientSecret` and `publishableKey` are meant for the browser; the Stripe
 * secret key never appears here.
 */
export type NextAction =
  | { type: "sandbox_settle" }
  | { type: "stripe_payment_element"; clientSecret: string; publishableKey: string }

/**
 * The outcome of the spend policy for one payment.
 *
 * `deny` beats `needs_approval`: a payment to a counterparty that is not on
 * the allowlist is never offered to a human.
 */
export type PolicyDecision =
  | { outcome: "allow"; rule: "within_limits" }
  | { outcome: "needs_approval"; rule: "amount_over_threshold"; threshold: Money }
  | { outcome: "deny"; rule: "invalid_amount" | "currency_not_supported" | "counterparty_not_allowed" }

/**
 * A payment as the payment service shows it.
 *
 * `payer` is the verified issuer of the initiation and `payee` the verified
 * issuer of the payment request token. `next` is present exactly when
 * `status` is `requires_payment`, `failure` exactly when it is `failed`, and
 * `approvalId` when the policy asked for approval.
 */
export interface PaymentView {
  paymentId: string
  status: PaymentStatus
  paymentRequestId: string
  paymentOptionId: string
  network: Network
  amount: Money
  description?: string
  payer: DidUri
  payee: DidUri
  policy: PolicyDecision
  approvalId?: string
  next?: NextAction
  failure?: string
}

/** The body of `POST /payments/:id/receipt`: the signed `PaymentReceiptCredential` as a JWT. */
export interface ReceiptBody {
  receipt: JwtString
}

/** A request for human approval, as the approver routes show it. Times are ISO 8601. */
export interface ApprovalView {
  approvalId: string
  paymentId: string
  status: "pending" | "approved" | "rejected"
  payer: DidUri
  payee: DidUri
  amount: Money
  description?: string
  requestedAt: string
  decidedAt?: string
  note?: string
}

/** The body of `GET /approvals`. */
export interface ApprovalListBody {
  approvals: ApprovalView[]
}

/** The body of `POST /approvals/:id/decision`. A decision is final. */
export interface ApprovalDecisionBody {
  decision: "approve" | "reject"
  note?: string
}

// ---------------------------------------------------------------------------
// Schemas. Each wire type has a schema named after it; both sides validate
// what they receive with these.
// ---------------------------------------------------------------------------

/** Validates a compact JWT string with a non-empty signature. */
export const jwtStringSchema = v.custom<JwtString>((value) => isJwtString(value), "must be a signed JWT")

/** Validates a DID URI. */
export const didSchema = v.custom<DidUri>((value) => v.is(didUriSchema, value), "must be a DID")

/** Validates {@link Network}. */
export const networkSchema = v.picklist(["sandbox", "stripe"])

/** Validates {@link Money}: a positive safe integer amount, integer decimals of at least 0, and a currency code. */
export const moneySchema = v.object({
  amount: v.custom<number>(isPositiveSafeInteger, "amount must be a positive safe integer"),
  decimals: v.pipe(v.number(), v.integer(), v.minValue(0)),
  currency: v.pipe(v.string(), v.nonEmpty()),
})

/** Validates {@link ErrorBody} with any string code. */
export const errorBodySchema = v.object({
  error: v.object({
    code: v.pipe(v.string(), v.nonEmpty()),
    message: v.string(),
    details: v.optional(v.record(v.string(), v.unknown())),
  }),
})

/** Validates {@link ReceiptErrorCode}. */
export const receiptErrorCodeSchema = v.picklist(RECEIPT_ERROR_CODES)

/** Validates {@link PaymentRequiredBody}; the payment request is checked with the ACK schema. */
export const paymentRequiredBodySchema = v.object({
  paymentRequest: paymentRequestSchema,
  paymentRequestToken: jwtStringSchema,
  error: v.optional(
    v.object({
      code: receiptErrorCodeSchema,
      message: v.string(),
      details: v.optional(v.record(v.string(), v.unknown())),
    }),
  ),
})

/** Validates {@link ResourceSummary}. */
export const resourceSummarySchema = v.object({
  id: v.pipe(v.string(), v.nonEmpty()),
  title: v.string(),
  price: moneySchema,
})

/** Validates {@link ResourceListBody}. */
export const resourceListBodySchema = v.object({ resources: v.array(resourceSummarySchema) })

/** Validates {@link ResourceBody}. */
export const resourceBodySchema = v.object({
  id: v.pipe(v.string(), v.nonEmpty()),
  title: v.string(),
  content: v.string(),
})

/** Validates {@link InitiatePaymentBody}. */
export const initiatePaymentBodySchema = v.object({ initiation: jwtStringSchema })

/** Validates the private claims of an initiation JWT ({@link PaymentInitiationClaims}). */
export const paymentInitiationClaimsSchema = v.object({
  paymentRequestToken: jwtStringSchema,
  paymentOptionId: v.pipe(v.string(), v.nonEmpty()),
})

/** Validates {@link PaymentStatus}. */
export const paymentStatusSchema = v.picklist(PAYMENT_STATUSES)

/** Validates {@link NextAction}. */
export const nextActionSchema = v.variant("type", [
  v.object({ type: v.literal("sandbox_settle") }),
  v.object({
    type: v.literal("stripe_payment_element"),
    clientSecret: v.pipe(v.string(), v.nonEmpty()),
    publishableKey: v.pipe(v.string(), v.startsWith("pk_")),
  }),
])

/** Validates {@link PolicyDecision}. */
export const policyDecisionSchema = v.variant("outcome", [
  v.object({ outcome: v.literal("allow"), rule: v.literal("within_limits") }),
  v.object({ outcome: v.literal("needs_approval"), rule: v.literal("amount_over_threshold"), threshold: moneySchema }),
  v.object({
    outcome: v.literal("deny"),
    rule: v.picklist(["invalid_amount", "currency_not_supported", "counterparty_not_allowed"]),
  }),
])

/**
 * Validates {@link PaymentView}, including that `next` is present exactly
 * when the status is `requires_payment` and `failure` exactly when it is
 * `failed`.
 */
export const paymentViewSchema = v.pipe(
  v.object({
    paymentId: v.pipe(v.string(), v.nonEmpty()),
    status: paymentStatusSchema,
    paymentRequestId: v.pipe(v.string(), v.nonEmpty()),
    paymentOptionId: v.pipe(v.string(), v.nonEmpty()),
    network: networkSchema,
    amount: moneySchema,
    description: v.optional(v.string()),
    payer: didSchema,
    payee: didSchema,
    policy: policyDecisionSchema,
    approvalId: v.optional(v.pipe(v.string(), v.nonEmpty())),
    next: v.optional(nextActionSchema),
    failure: v.optional(v.string()),
  }),
  v.check(
    (view) => (view.status === "requires_payment") === (view.next !== undefined),
    "next is present exactly when status is requires_payment",
  ),
  v.check((view) => (view.status === "failed") === (view.failure !== undefined), "failure is present exactly when status is failed"),
)

/** Validates {@link ReceiptBody}. */
export const receiptBodySchema = v.object({ receipt: jwtStringSchema })

/** Validates {@link ApprovalView}. */
export const approvalViewSchema = v.object({
  approvalId: v.pipe(v.string(), v.nonEmpty()),
  paymentId: v.pipe(v.string(), v.nonEmpty()),
  status: v.picklist(["pending", "approved", "rejected"]),
  payer: didSchema,
  payee: didSchema,
  amount: moneySchema,
  description: v.optional(v.string()),
  requestedAt: v.pipe(v.string(), v.isoTimestamp()),
  decidedAt: v.optional(v.pipe(v.string(), v.isoTimestamp())),
  note: v.optional(v.string()),
})

/** Validates {@link ApprovalListBody}. */
export const approvalListBodySchema = v.object({ approvals: v.array(approvalViewSchema) })

/** Validates {@link ApprovalDecisionBody}. */
export const approvalDecisionBodySchema = v.object({
  decision: v.picklist(["approve", "reject"]),
  note: v.optional(v.string()),
})

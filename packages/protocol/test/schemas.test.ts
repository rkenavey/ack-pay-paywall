import { describe, expect, it } from "vitest"
import * as v from "valibot"
import { buildPaymentRequest, fixtures, FIXED_START } from "@paywall/testkit"
import {
  approvalDecisionBodySchema,
  approvalListBodySchema,
  approvalViewSchema,
  errorBodySchema,
  initiatePaymentBodySchema,
  moneySchema,
  nextActionSchema,
  paymentInitiationClaimsSchema,
  paymentRequiredBodySchema,
  paymentViewSchema,
  policyDecisionSchema,
  protocolEventSchema,
  receiptBodySchema,
  resourceBodySchema,
  resourceListBodySchema,
  resourceSummarySchema,
  type ApprovalDecisionBody,
  type ApprovalView,
  type ErrorBody,
  type InitiatePaymentBody,
  type Money,
  type NextAction,
  type PaymentInitiationClaims,
  type PaymentRequiredBody,
  type PaymentView,
  type PolicyDecision,
  type ProtocolEvent,
  type ReceiptBody,
  type ResourceBody,
  type ResourceSummary,
} from "../src/index.ts"

// Compile-time: each schema's output is assignable to the interface it is named after.
type Assignable<A, B> = [A] extends [B] ? true : false
const schemaTypesMatch: [
  Assignable<v.InferOutput<typeof moneySchema>, Money>,
  Assignable<v.InferOutput<typeof errorBodySchema>, ErrorBody>,
  Assignable<v.InferOutput<typeof paymentRequiredBodySchema>, PaymentRequiredBody>,
  Assignable<v.InferOutput<typeof resourceSummarySchema>, ResourceSummary>,
  Assignable<v.InferOutput<typeof resourceBodySchema>, ResourceBody>,
  Assignable<v.InferOutput<typeof initiatePaymentBodySchema>, InitiatePaymentBody>,
  Assignable<v.InferOutput<typeof paymentInitiationClaimsSchema>, PaymentInitiationClaims>,
  Assignable<v.InferOutput<typeof nextActionSchema>, NextAction>,
  Assignable<v.InferOutput<typeof policyDecisionSchema>, PolicyDecision>,
  Assignable<v.InferOutput<typeof paymentViewSchema>, PaymentView>,
  Assignable<v.InferOutput<typeof receiptBodySchema>, ReceiptBody>,
  Assignable<v.InferOutput<typeof approvalViewSchema>, ApprovalView>,
  Assignable<v.InferOutput<typeof approvalDecisionBodySchema>, ApprovalDecisionBody>,
  Assignable<v.InferOutput<typeof protocolEventSchema>, ProtocolEvent>,
] = [true, true, true, true, true, true, true, true, true, true, true, true, true, true]

const usd = (amount: number): Money => ({ amount, decimals: 2, currency: "USD" })
const { paymentRequest, paymentRequestToken } = await buildPaymentRequest({ now: FIXED_START, id: "pr_0001" })

const paymentView: PaymentView = {
  paymentId: "pay_0001",
  status: "requires_payment",
  paymentRequestId: "pr_0001",
  paymentOptionId: "sandbox-usd",
  network: "sandbox",
  amount: usd(500),
  description: "Market brief",
  payer: fixtures.client.did,
  payee: fixtures.acme.did,
  policy: { outcome: "allow", rule: "within_limits" },
  next: { type: "sandbox_settle" },
}

const approvalView: ApprovalView = {
  approvalId: "apr_0001",
  paymentId: "pay_0001",
  status: "pending",
  payer: fixtures.client.did,
  payee: fixtures.acme.did,
  amount: usd(7500),
  description: "Annual report",
  requestedAt: "2026-11-10T14:02:00.000Z",
}

// Each case: a valid example, then examples that break one field.
const cases: Array<{ name: string; schema: v.GenericSchema; valid: unknown; invalid: Record<string, unknown> }> = [
  {
    name: "moneySchema",
    schema: moneySchema,
    valid: usd(5000),
    invalid: {
      "missing currency": { amount: 5000, decimals: 2 },
      "string amount": { amount: "5000", decimals: 2, currency: "USD" },
      "fractional amount": { amount: 50.5, decimals: 2, currency: "USD" },
      "zero amount": { amount: 0, decimals: 2, currency: "USD" },
      "unsafe amount": { amount: 2 ** 53, decimals: 2, currency: "USD" },
      "negative decimals": { amount: 5000, decimals: -1, currency: "USD" },
    },
  },
  {
    name: "errorBodySchema",
    schema: errorBodySchema,
    valid: { error: { code: "policy_denied", message: "denied", details: { rule: "counterparty_not_allowed" } } },
    invalid: {
      "missing message": { error: { code: "policy_denied" } },
      "numeric code": { error: { code: 403, message: "denied" } },
      "no error object": { code: "policy_denied", message: "denied" },
    },
  },
  {
    name: "paymentRequiredBodySchema",
    schema: paymentRequiredBodySchema,
    valid: { paymentRequest, paymentRequestToken, error: { code: "receipt_expired", message: "expired" } },
    invalid: {
      "missing token": { paymentRequest },
      "token is not a JWT": { paymentRequest, paymentRequestToken: "not-a-jwt" },
      "request without options": { paymentRequest: { ...paymentRequest, paymentOptions: [] }, paymentRequestToken },
      "unknown error code": { paymentRequest, paymentRequestToken, error: { code: "nope", message: "x" } },
    },
  },
  {
    name: "resourceSummarySchema",
    schema: resourceSummarySchema,
    valid: { id: "market-brief", title: "Market brief", price: usd(500) },
    invalid: {
      "missing price": { id: "market-brief", title: "Market brief" },
      "string price amount": { id: "market-brief", title: "Market brief", price: { ...usd(500), amount: "5.00" } },
    },
  },
  {
    name: "resourceListBodySchema",
    schema: resourceListBodySchema,
    valid: { resources: [{ id: "market-brief", title: "Market brief", price: usd(500) }] },
    invalid: { "resources not an array": { resources: { id: "market-brief" } } },
  },
  {
    name: "resourceBodySchema",
    schema: resourceBodySchema,
    valid: { id: "market-brief", title: "Market brief", content: "text" },
    invalid: { "missing content": { id: "market-brief", title: "Market brief" }, "numeric id": { id: 1, title: "t", content: "c" } },
  },
  {
    name: "initiatePaymentBodySchema",
    schema: initiatePaymentBodySchema,
    valid: { initiation: paymentRequestToken },
    invalid: { "missing initiation": {}, "initiation is not a JWT": { initiation: "hello" } },
  },
  {
    name: "paymentInitiationClaimsSchema",
    schema: paymentInitiationClaimsSchema,
    valid: { paymentRequestToken, paymentOptionId: "sandbox-usd" },
    invalid: {
      "missing option id": { paymentRequestToken },
      "missing token": { paymentOptionId: "sandbox-usd" },
      "numeric option id": { paymentRequestToken, paymentOptionId: 1 },
    },
  },
  {
    name: "nextActionSchema",
    schema: nextActionSchema,
    valid: { type: "stripe_payment_element", clientSecret: "pi_1_secret_2", publishableKey: "pk_test_123" },
    invalid: {
      "unknown type": { type: "wire_transfer" },
      "stripe without client secret": { type: "stripe_payment_element", publishableKey: "pk_test_123" },
    },
  },
  {
    name: "policyDecisionSchema",
    schema: policyDecisionSchema,
    valid: { outcome: "needs_approval", rule: "amount_over_threshold", threshold: usd(5000) },
    invalid: {
      "approval without threshold": { outcome: "needs_approval", rule: "amount_over_threshold" },
      "deny with unknown rule": { outcome: "deny", rule: "too_expensive" },
      "allow with deny rule": { outcome: "allow", rule: "invalid_amount" },
    },
  },
  {
    name: "paymentViewSchema",
    schema: paymentViewSchema,
    valid: paymentView,
    invalid: {
      "missing payer": { ...paymentView, payer: undefined },
      "payee is not a DID": { ...paymentView, payee: "acme" },
      "unknown status": { ...paymentView, status: "paid" },
      "unknown network": { ...paymentView, network: "lightning" },
      "requires_payment without next": { ...paymentView, next: undefined },
      "settled with next": { ...paymentView, status: "settled" },
      "failed without failure": { ...paymentView, status: "failed", next: undefined },
    },
  },
  {
    name: "receiptBodySchema",
    schema: receiptBodySchema,
    valid: { receipt: paymentRequestToken },
    invalid: { "missing receipt": {}, "receipt is not a JWT": { receipt: "a.b" } },
  },
  {
    name: "approvalViewSchema",
    schema: approvalViewSchema,
    valid: approvalView,
    invalid: {
      "missing payee": { ...approvalView, payee: undefined },
      "unknown status": { ...approvalView, status: "maybe" },
      "requestedAt not a timestamp": { ...approvalView, requestedAt: "yesterday" },
    },
  },
  {
    name: "approvalListBodySchema",
    schema: approvalListBodySchema,
    valid: { approvals: [approvalView] },
    invalid: { "approval missing amount": { approvals: [{ ...approvalView, amount: undefined }] } },
  },
  {
    name: "approvalDecisionBodySchema",
    schema: approvalDecisionBodySchema,
    valid: { decision: "approve", note: "ok" },
    invalid: { "missing decision": { note: "ok" }, "unknown decision": { decision: "maybe" } },
  },
  {
    name: "protocolEventSchema",
    schema: protocolEventSchema,
    valid: { name: "ps.policy.evaluated", actor: "payment-service", at: "2026-11-10T14:02:00.000Z", data: { outcome: "allow" } },
    invalid: {
      "unknown event name": { name: "ps.coffee.made", actor: "payment-service", at: "2026-11-10T14:02:00.000Z" },
      "object in data": { name: "ps.policy.evaluated", actor: "payment-service", at: "2026-11-10T14:02:00.000Z", data: { x: {} } },
    },
  },
]

describe("wire schemas", () => {
  it("PRO-1: the schema types match the wire interfaces", () => {
    expect(schemaTypesMatch.every(Boolean)).toBe(true)
  })

  for (const { name, schema, valid, invalid } of cases) {
    it(`PRO-1: ${name} accepts a valid example`, () => {
      const result = v.safeParse(schema, valid)
      expect(result.issues).toBeUndefined()
      expect(result.success).toBe(true)
    })

    for (const [label, example] of Object.entries(invalid)) {
      it(`PRO-1: ${name} rejects an example with ${label}`, () => {
        expect(v.safeParse(schema, example).success).toBe(false)
      })
    }
  }

  it("PRO-1: the payment-required body is validated with the ACK payment request schema", () => {
    const withoutRecipient = {
      ...paymentRequest,
      paymentOptions: paymentRequest.paymentOptions.map(({ recipient: _recipient, ...rest }) => rest),
    }
    expect(v.safeParse(paymentRequiredBodySchema, { paymentRequest: withoutRecipient, paymentRequestToken }).success).toBe(false)
  })
})

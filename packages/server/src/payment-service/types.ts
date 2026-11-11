import type { Resolvable } from "agentcommercekit"
import type {
  AgentIdentity,
  Clock,
  DidUri,
  EventLog,
  IdGenerator,
  JwtString,
  Money,
  Network,
  NextAction,
  PaymentStatus,
  PolicyDecision,
} from "@paywall/protocol"
import type { SpendRequest } from "../policy/index.ts"

/**
 * A payment as the payment service stores it.
 *
 * Amount, currency, payee and expiry are copied from the verified payment
 * request token when the payment is created and never from the client.
 */
export interface PaymentRecord {
  id: string
  status: PaymentStatus
  paymentRequestId: string
  paymentRequestToken: JwtString
  paymentOptionId: string
  network: Network
  amount: Money
  description?: string
  payer: DidUri
  payee: DidUri
  expiresAt?: Date
  policy: PolicyDecision
  approvalId?: string
  next?: NextAction
  failure?: string
  settlement?: { ref: string; settledAt: Date }
  receipt?: JwtString
}

/** Storage for payments. */
export interface PaymentStore {
  create(record: PaymentRecord): Promise<void>
  get(id: string): Promise<PaymentRecord | undefined>
  /** Finds the payment a payer already started for this request and option. */
  findByKey(payer: DidUri, paymentRequestId: string, paymentOptionId: string): Promise<PaymentRecord | undefined>
  /** Compare-and-set on status: applies `patch` only when the record is in `from`, and resolves false otherwise. */
  transition(id: string, from: PaymentStatus, patch: Partial<PaymentRecord> & { status: PaymentStatus }): Promise<boolean>
}

/** What a settlement adapter found when it checked a payment. */
export type SettlementResult =
  | { settled: true; ref: string; settledAt: Date }
  | { settled: false; reason: "pending" | "failed" | "mismatch"; detail?: string }

/**
 * Moves money on one network.
 *
 * `begin` is the only place money movement starts and is idempotent per
 * payment id. `verify` is the authoritative, server-side check that the money
 * arrived; the client's word is never evidence.
 */
export interface SettlementAdapter {
  readonly network: Network
  begin(payment: PaymentRecord): Promise<NextAction>
  verify(payment: PaymentRecord): Promise<SettlementResult>
}

/**
 * The sandbox adapter: settles against an in-memory ledger and moves no real
 * money. The sandbox settle route records the payment as paid with
 * `markPaid`; `verify` reads the ledger.
 */
export interface SandboxAdapter extends SettlementAdapter {
  readonly network: "sandbox"
  markPaid(payment: PaymentRecord, at: Date): Promise<void>
}

/** The input for creating a PaymentIntent. `amount` is in minor units. */
export interface CreatePaymentIntentInput {
  amount: number
  currency: string
  description?: string
  metadata: Record<string, string>
  idempotencyKey: string
}

/** The fields of a PaymentIntent the payment service reads. Amounts are in minor units. */
export interface PaymentIntentSnapshot {
  id: string
  status: string
  amount: number
  amountReceived: number
  currency: string
  metadata: Record<string, string>
}

/**
 * The seam over the Stripe SDK, so tests can replace Stripe with a fake.
 *
 * `constructWebhookEvent` throws when the signature does not verify.
 */
export interface StripeGateway {
  createPaymentIntent(input: CreatePaymentIntentInput): Promise<{ id: string; clientSecret: string }>
  retrievePaymentIntent(id: string): Promise<PaymentIntentSnapshot>
  constructWebhookEvent(rawBody: string, signature: string): { id: string; type: string; paymentIntentId?: string }
}

/** A request for a human to approve one payment. */
export interface Approval {
  id: string
  paymentId: string
  status: "pending" | "approved" | "rejected"
  requestedAt: Date
  decidedAt?: Date
  note?: string
}

/** Storage for approvals. */
export interface ApprovalStore {
  create(approval: Approval): Promise<void>
  get(id: string): Promise<Approval | undefined>
  list(status?: Approval["status"]): Promise<Approval[]>
  /** Records the decision. Atomic: resolves true for the first decision only. */
  decide(id: string, status: "approved" | "rejected", at: Date, note?: string): Promise<boolean>
}

/**
 * Everything the payment service needs.
 *
 * `publicUrl` must equal the `paymentService` of the options it accepts, and
 * `identity.did` their `receiptService`. `approverToken` is the bearer token
 * of the human approver. `stripe` is present when Stripe keys are configured.
 */
export interface PaymentServiceDeps {
  identity: AgentIdentity
  publicUrl: string
  policy: (request: SpendRequest) => PolicyDecision
  adapters: readonly SettlementAdapter[]
  payments: PaymentStore
  approvals: ApprovalStore
  approverToken: string
  receiptTtlSeconds: number
  stripe?: { gateway: StripeGateway; webhookConfigured: boolean }
  resolver: Resolvable
  clock: Clock
  ids: IdGenerator
  log: EventLog
}

import type { Resolvable } from "agentcommercekit"
import type {
  AgentIdentity,
  Clock,
  DidUri,
  EventLog,
  JwtString,
  Network,
  NextAction,
  PaymentOption,
  PaymentRequiredBody,
  PaymentView,
  ResourceBody,
} from "@paywall/protocol"

/**
 * Does the client-side part of paying on one network.
 *
 * `execute` resolving means "ask the payment service for the receipt now",
 * not "settled": the payment service verifies settlement itself. Throwing
 * fails the run with `payment_failed`.
 */
export interface PaymentExecutor {
  readonly network: Network
  execute(ctx: {
    payment: PaymentView
    next: NextAction
    paymentServiceUrl: string
    fetch: typeof fetch
    signal: AbortSignal
  }): Promise<void>
}

/**
 * Picks the payment option to pay with, among options whose network is in
 * `supported`, or `undefined` when none fits.
 */
export type OptionSelector = (options: readonly PaymentOption[], supported: readonly Network[]) => PaymentOption | undefined

/** Where a run is. A run ends in `delivered` or `failed`. */
export type FlowStatus =
  | "idle"
  | "requesting"
  | "verifying_request"
  | "selecting_option"
  | "initiating"
  | "awaiting_approval"
  | "paying"
  | "fetching_receipt"
  | "retrying"
  | "delivered"
  | "failed"

/** Why a run failed. */
export type FlowFailure =
  | "payment_request_invalid"
  | "payment_request_mismatch"
  | "payment_request_expired"
  | "no_supported_option"
  | "policy_denied"
  | "approval_rejected"
  | "approval_timeout"
  | "payment_failed"
  | "receipt_invalid"
  | "payment_not_accepted"
  | "http_error"
  | "aborted"

/**
 * The state of a run, as `subscribe` listeners see it. Fields fill in as the
 * run progresses; `paymentRequired` is the 402 body after the token verified.
 */
export interface FlowState {
  status: FlowStatus
  paymentRequired?: PaymentRequiredBody
  payee?: DidUri
  selectedOption?: PaymentOption
  payment?: PaymentView
  receipt?: JwtString
  resource?: ResourceBody
  failure?: { code: FlowFailure; message: string; details?: Record<string, unknown> }
}

/**
 * Everything the client agent needs. `approvalPoll` is in milliseconds:
 * how often to re-read a payment that waits for a human, and how long to
 * wait in total.
 */
export interface PaywallClientDeps {
  fetch: typeof fetch
  identity: AgentIdentity
  executors: readonly PaymentExecutor[]
  selectOption: OptionSelector
  resolver: Resolvable
  clock: Clock
  log: EventLog
  approvalPoll: { intervalMs: number; timeoutMs: number }
}

/** The client agent. */
export interface PaywallClient {
  /**
   * Fetches a paywalled URL, paying for it when it answers 402. Resolves with
   * the final state, `delivered` or `failed`; it never rejects for protocol
   * failures, and one call never pays twice.
   */
  fetchPaid(url: string, init?: { signal?: AbortSignal }): Promise<FlowState>
  /** Calls `listener` with every new state. Returns the unsubscribe function. */
  subscribe(listener: (state: FlowState) => void): () => void
}

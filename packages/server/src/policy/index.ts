import type { DidUri, Money, PolicyDecision } from "@paywall/protocol"

/** The policy's decision type, defined in the protocol package because payment views carry it. */
export type { PolicyDecision } from "@paywall/protocol"

/** Raised by the policy stubs until the spend policy is built. */
class NotImplementedError extends Error {
  constructor(task: string) {
    super(`not implemented yet (${task})`)
    this.name = "NotImplementedError"
  }
}

/**
 * The spend policy's configuration.
 *
 * `allowedCounterparties` lists the payee DIDs the payer may pay, compared as
 * exact strings; an empty list denies everything. Amounts above
 * `approvalThreshold` need a human; the threshold's currency and decimals are
 * also the only denomination the policy accepts.
 */
export interface SpendPolicyConfig {
  allowedCounterparties: readonly DidUri[]
  approvalThreshold: Money
}

/**
 * One payment, as the payment service asks the policy about it. Every field
 * comes from verified tokens: the counterparty is the payee, the DID that
 * issued the payment request.
 */
export interface SpendRequest {
  payer: DidUri
  counterparty: DidUri
  amount: Money
  paymentRequestId: string
  description?: string
}

/** The approval threshold used when none is configured: $50.00. */
export const DEFAULT_APPROVAL_THRESHOLD: Money = { amount: 5000, decimals: 2, currency: "USD" }

/**
 * Decides whether a payment may go ahead, needs a human, or is denied.
 *
 * Pure, synchronous and total: no clock, randomness, I/O or environment, and
 * it never throws. The first matching rule wins: invalid amount, unsupported
 * currency, counterparty not on the allowlist, amount over the threshold,
 * otherwise allow.
 */
export function evaluateSpend(request: SpendRequest, config: SpendPolicyConfig): PolicyDecision {
  void request
  void config
  throw new NotImplementedError("T2")
}

/**
 * Reads the policy configuration from environment-style variables:
 * `POLICY_ALLOWED_COUNTERPARTIES` (comma-separated DIDs, required, may be
 * empty) and `POLICY_APPROVAL_THRESHOLD_MINOR` (USD cents, default 5000).
 *
 * Throws an error naming the variable when one is missing or malformed.
 */
export function parseSpendPolicyConfig(env: Record<string, string | undefined>): SpendPolicyConfig {
  void env
  throw new NotImplementedError("T2")
}

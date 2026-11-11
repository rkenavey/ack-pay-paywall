import type { DidUri, Money, PolicyDecision } from "@paywall/protocol"

/** The policy's decision type, defined in the protocol package because payment views carry it. */
export type { PolicyDecision } from "@paywall/protocol"

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
 * otherwise allow. Malformed input fails closed with a deny: a request with no
 * usable amount is `invalid_amount`, a configuration with no usable threshold
 * is `currency_not_supported`, and one with no allowlist is
 * `counterparty_not_allowed`.
 */
export function evaluateSpend(request: SpendRequest, config: SpendPolicyConfig): PolicyDecision {
  try {
    return decide(request, config)
  } catch {
    // Only reachable through hostile input such as a throwing getter; fail closed.
    return { outcome: "deny", rule: "invalid_amount" }
  }
}

function decide(request: SpendRequest, config: SpendPolicyConfig): PolicyDecision {
  const amount: unknown = isRecord(request) && isRecord(request.amount) ? request.amount.amount : undefined
  if (!isPositiveSafeInteger(amount)) return { outcome: "deny", rule: "invalid_amount" }

  const threshold = isRecord(config) ? config.approvalThreshold : undefined
  if (!isUsableThreshold(threshold)) return { outcome: "deny", rule: "currency_not_supported" }
  if (request.amount.currency !== threshold.currency || request.amount.decimals !== threshold.decimals) {
    return { outcome: "deny", rule: "currency_not_supported" }
  }

  const allowed: unknown = config.allowedCounterparties
  if (!Array.isArray(allowed) || typeof request.counterparty !== "string" || !allowed.includes(request.counterparty)) {
    return { outcome: "deny", rule: "counterparty_not_allowed" }
  }

  if (amount > threshold.amount) {
    return {
      outcome: "needs_approval",
      rule: "amount_over_threshold",
      threshold: { amount: threshold.amount, decimals: threshold.decimals, currency: threshold.currency },
    }
  }
  return { outcome: "allow", rule: "within_limits" }
}

const THRESHOLD_VARIABLE = "POLICY_APPROVAL_THRESHOLD_MINOR"
const ALLOWLIST_VARIABLE = "POLICY_ALLOWED_COUNTERPARTIES"

// DID syntax from DID Core: "did:", a lowercase method name, then a
// method-specific id of idchars and percent-escapes, with inner colons.
const DID_PATTERN = /^did:[a-z0-9]+:(?:[A-Za-z0-9._-]|%[0-9A-Fa-f]{2})*(?::(?:[A-Za-z0-9._-]|%[0-9A-Fa-f]{2})*)*$/
const MINOR_UNITS_PATTERN = /^[0-9]+$/

/**
 * Reads the policy configuration from environment-style variables:
 * `POLICY_ALLOWED_COUNTERPARTIES` (comma-separated DIDs, required, may be
 * empty) and `POLICY_APPROVAL_THRESHOLD_MINOR` (USD cents, a positive
 * integer, default 5000; an empty value means the default).
 *
 * Whitespace around each DID and empty entries are ignored. Throws an error
 * naming the variable when one is missing or malformed; the message does not
 * repeat the value.
 */
export function parseSpendPolicyConfig(env: Record<string, string | undefined>): SpendPolicyConfig {
  const rawList = env[ALLOWLIST_VARIABLE]
  if (rawList === undefined) throw new Error(`${ALLOWLIST_VARIABLE} is required (comma-separated DIDs; empty denies every payment)`)
  const allowedCounterparties: DidUri[] = []
  const entries = rawList.split(",").map((entry) => entry.trim())
  entries.forEach((entry, index) => {
    if (entry === "") return
    if (!isDid(entry)) throw new Error(`${ALLOWLIST_VARIABLE} entry ${index + 1} is not a DID`)
    allowedCounterparties.push(entry)
  })

  const rawThreshold = env[THRESHOLD_VARIABLE]
  let approvalThreshold: Money = { ...DEFAULT_APPROVAL_THRESHOLD }
  if (rawThreshold !== undefined && rawThreshold !== "") {
    const amount = MINOR_UNITS_PATTERN.test(rawThreshold) ? Number(rawThreshold) : Number.NaN
    if (!Number.isSafeInteger(amount) || amount <= 0) {
      throw new Error(`${THRESHOLD_VARIABLE} must be a positive whole number of US cents`)
    }
    approvalThreshold = { ...DEFAULT_APPROVAL_THRESHOLD, amount }
  }

  return { allowedCounterparties, approvalThreshold }
}

function isDid(value: string): value is DidUri {
  return DID_PATTERN.test(value) && !value.endsWith(":")
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
}

function isUsableThreshold(value: unknown): value is Money {
  return (
    isRecord(value) &&
    typeof value.amount === "number" &&
    Number.isSafeInteger(value.amount) &&
    value.amount > 0 &&
    typeof value.decimals === "number" &&
    typeof value.currency === "string"
  )
}

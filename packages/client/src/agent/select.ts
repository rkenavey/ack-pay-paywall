import type { Network } from "@paywall/protocol"
import type { OptionSelector } from "./types.ts"

/** The approval polling used when none is configured: every second, for at most five minutes. */
export const DEFAULT_APPROVAL_POLL = { intervalMs: 1000, timeoutMs: 300_000 } as const

// Stripe first: when both are offered, the real payment network wins over the sandbox.
const PREFERENCE: readonly Network[] = ["stripe", "sandbox"]

/**
 * The default option selector: the first option on a supported network,
 * preferring `stripe` over `sandbox`. Deterministic: the same inputs always
 * select the same option.
 */
export const defaultSelectOption: OptionSelector = (options, supported) => {
  for (const network of PREFERENCE) {
    if (!supported.includes(network)) continue
    const option = options.find((candidate) => candidate.network === network)
    if (option) return option
  }
  return undefined
}

import { NotImplementedError } from "@paywall/protocol"
import type { OptionSelector } from "./types.ts"

/** The approval polling used when none is configured: every second, for at most five minutes. */
export const DEFAULT_APPROVAL_POLL = { intervalMs: 1000, timeoutMs: 300_000 } as const

/**
 * The default option selector: the first option on a supported network,
 * preferring `stripe` over `sandbox`. Deterministic: the same inputs always
 * select the same option.
 */
export const defaultSelectOption: OptionSelector = (options, supported) => {
  void options
  void supported
  throw new NotImplementedError("T4")
}
